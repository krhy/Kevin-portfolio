// End-to-end tests of the Worker's API with in-memory KV/R2.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../_worker.js";
import { BACKUP_PREFIX, makeBackupId } from "../pickleball-backups.js";
import { mockEnv, req, ledger, PB_PW, INV_PW, ORIGIN } from "./helpers.mjs";

const KEY = "pickleball:entries";
// Real saves are seconds apart; wait a few ms before each change so backup
// timestamps (and so their newest-first order) are always distinct.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (env, path, opts = {}) => {
  if (opts.method && opts.method !== "GET") await sleep(3);
  return worker.fetch(req(path, opts), env);
};
const save = (env, body, password = PB_PW, extra = {}) =>
  call(env, "/api/pickleball/entries", { method: "PUT", password, body: JSON.stringify(body), ...extra });
const backupKeys = (env) => [...env.MY_BUCKET.objects.keys()].filter((k) => k.startsWith(BACKUP_PREFIX));

test("saving requires the pickleball password; no backup is made on refusal", async () => {
  const env = mockEnv();
  await env.PICKLEBALL_FUND.put(KEY, JSON.stringify(ledger(1)));
  assert.equal((await save(env, ledger(2), "")).status, 401, "no password");
  assert.equal((await save(env, ledger(2), INV_PW)).status, 401);
  assert.equal(backupKeys(env).length, 0);
  assert.equal(JSON.parse(env.PICKLEBALL_FUND.store.get(KEY)).contributions.length, 1);
});

test("every save backs up the previous ledger first", async () => {
  const env = mockEnv();
  assert.equal((await save(env, ledger(1))).status, 200);
  assert.equal(backupKeys(env).length, 0, "nothing to back up on the very first save");
  assert.equal((await save(env, ledger(2))).status, 200);
  assert.equal((await save(env, ledger(3))).status, 200);
  const keys = backupKeys(env);
  assert.equal(keys.length, 2);
  const newest = env.MY_BUCKET.objects.get(keys.sort()[0]);
  assert.equal(JSON.parse(newest.body).contributions.length, 2, "newest backup = state before the last save");
  assert.equal(newest.customMetadata.reason, "before-save");
  assert.equal(newest.customMetadata.contributions, "2");
});

test("saving identical data does not create a backup", async () => {
  const env = mockEnv();
  await save(env, ledger(1));
  await save(env, ledger(1));
  assert.equal(backupKeys(env).length, 0);
});

test("a failing backup does not block saving", async () => {
  const env = mockEnv();
  await save(env, ledger(1));
  env.MY_BUCKET.put = async () => { throw new Error("R2 down"); };
  const origError = console.error; console.error = () => {};
  try {
    assert.equal((await save(env, ledger(2))).status, 200);
  } finally { console.error = origError; }
  assert.equal(JSON.parse(env.PICKLEBALL_FUND.store.get(KEY)).contributions.length, 2);
});

test("ledger size limit is 24 MiB (old 5 MB limit removed)", async () => {
  const env = mockEnv();
  const big = ledger(1, { padding: "x".repeat(10 * 1024 * 1024) });
  assert.equal((await save(env, big)).status, 200, "10 MB ledger saves");
  const huge = ledger(1, { padding: "x".repeat(25 * 1024 * 1024) });
  assert.equal((await save(env, huge)).status, 413);
});

test("public view hides device details; unlocked view shows them", async () => {
  const env = mockEnv();
  await env.PICKLEBALL_FUND.put(KEY, JSON.stringify(ledger(1, {
    activityLogs: [{ id: "l1", description: "Added game", deviceId: "dev_abc", userAgent: "iPhone Safari", environment: { timezone: "Asia/Manila" } }],
  })));
  const pub = await (await call(env, "/api/pickleball/entries")).json();
  assert.equal(pub.activityLogs[0].description, "Added game");
  assert.equal(pub.activityLogs[0].deviceId, undefined);
  assert.equal(pub.activityLogs[0].userAgent, undefined);
  assert.equal(pub.activityLogs[0].environment, undefined);
  assert.equal(pub.contributions.length, 1, "entries still public");
  const wrong = await (await call(env, "/api/pickleball/entries", { password: INV_PW })).json();
  assert.equal(wrong.activityLogs[0].deviceId, undefined, "wrong password = public view");
  const full = await (await call(env, "/api/pickleball/entries", { password: PB_PW })).json();
  assert.equal(full.activityLogs[0].deviceId, "dev_abc");
});

test("saving the public view does not erase stored device details", async () => {
  const env = mockEnv();
  await env.PICKLEBALL_FUND.put(KEY, JSON.stringify(ledger(1, {
    activityLogs: [{ id: "l1", description: "Added", deviceId: "dev_abc", userAgent: "UA", environment: { a: 1 } }],
  })));
  const pub = await (await call(env, "/api/pickleball/entries")).json();
  pub.contributions.push({ id: "new" });
  assert.equal((await save(env, pub)).status, 200);
  const stored = JSON.parse(env.PICKLEBALL_FUND.store.get(KEY));
  assert.equal(stored.activityLogs[0].deviceId, "dev_abc");
  assert.equal(stored.contributions.length, 2);
});

test("backups API needs the pickleball password", async () => {
  const env = mockEnv();
  for (const pw of [undefined, "wrong", INV_PW]) {
    assert.equal((await call(env, "/api/pickleball/backups", { password: pw })).status, 401);
    assert.equal((await call(env, "/api/pickleball/backups/" + makeBackupId(Date.now()), { password: pw })).status, 401);
    assert.equal((await call(env, "/api/pickleball/backups/" + makeBackupId(Date.now()) + "/restore", { method: "POST", password: pw })).status, 401);
  }
});

test("list is newest first with counts; preview returns the backup", async () => {
  const env = mockEnv();
  for (const n of [1, 2, 3, 4]) await save(env, ledger(n));
  const list = await (await call(env, "/api/pickleball/backups", { password: PB_PW })).json();
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items.map((i) => i.contributions), [3, 2, 1]);
  assert.equal(list.items[0].reason, "before-save");
  const prev = await (await call(env, "/api/pickleball/backups/" + list.items[0].id, { password: PB_PW })).json();
  assert.equal(prev.contributions.length, 3);
});

test("list pages through many backups", async () => {
  const env = mockEnv();
  for (let i = 0; i < 35; i++) await env.MY_BUCKET.put(BACKUP_PREFIX + makeBackupId(1_700_000_000_000 + i * 1000, "aaaaa" + (i % 10)) + ".json", "{}");
  const p1 = await (await call(env, "/api/pickleball/backups", { password: PB_PW })).json();
  assert.equal(p1.items.length, 30);
  assert.ok(p1.cursor);
  const p2 = await (await call(env, "/api/pickleball/backups?cursor=" + p1.cursor, { password: PB_PW })).json();
  assert.equal(p2.items.length, 5);
  assert.equal(p2.cursor, null);
});

test("bad or sneaky backup ids are rejected", async () => {
  const env = mockEnv();
  await save(env, ledger(1)); await save(env, ledger(2)); // one real backup exists
  for (const id of ["..%2F..%2Fpickleball", "x", "..%2Fimages", makeBackupId(Date.now())]) {
    const r = await call(env, "/api/pickleball/backups/" + id, { password: PB_PW });
    assert.equal(r.status, 404, id);
  }
  // A literal "../" is resolved by the URL itself to another page; it must not return backup data.
  for (const p of ["/api/pickleball/backups/../images", "/api/pickleball/backups/%2E%2E"]) {
    const r = await call(env, p, { password: PB_PW });
    assert.equal(await r.text(), "static asset", p);
  }
});

test("wipe then restore brings the data back, and the restore can be undone", async () => {
  const env = mockEnv();
  const good = ledger(5, { activityLogs: [{ id: "g1", description: "Added game", deviceId: "dev1" }] });
  await save(env, good);
  // Someone wipes the ledger
  await save(env, { contributions: [], bookings: [], expenses: [], activityLogs: [{ id: "w1", description: "Wiped" }], version: 2 });
  assert.equal(JSON.parse(env.PICKLEBALL_FUND.store.get(KEY)).contributions.length, 0);

  const list = await (await call(env, "/api/pickleball/backups", { password: PB_PW })).json();
  const target = list.items.find((i) => i.contributions === 5);
  const r = await call(env, `/api/pickleball/backups/${target.id}/restore`, { method: "POST", password: PB_PW, origin: ORIGIN });
  assert.equal(r.status, 200);
  const after = JSON.parse(env.PICKLEBALL_FUND.store.get(KEY));
  assert.equal(after.contributions.length, 5, "data restored");
  assert.match(after.activityLogs[0].description, /^Restored server backup/);
  assert.equal(after.activityLogs[1].description, "Wiped", "audit trail of the wipe is kept");
  assert.ok(after.version > 2);

  // The wiped state was backed up before restoring, so the restore is undoable
  const list2 = await (await call(env, "/api/pickleball/backups", { password: PB_PW })).json();
  assert.equal(list2.items[0].reason, "before-restore");
  assert.equal(list2.items[0].contributions, 0);
  const undo = await call(env, `/api/pickleball/backups/${list2.items[0].id}/restore`, { method: "POST", password: PB_PW });
  assert.equal(undo.status, 200);
  assert.equal(JSON.parse(env.PICKLEBALL_FUND.store.get(KEY)).contributions.length, 0);
});

test("restore from another website is blocked", async () => {
  const env = mockEnv();
  await save(env, ledger(1)); await save(env, ledger(2));
  const list = await (await call(env, "/api/pickleball/backups", { password: PB_PW })).json();
  const r = await call(env, `/api/pickleball/backups/${list.items[0].id}/restore`, { method: "POST", password: PB_PW, origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(env.PICKLEBALL_FUND.store.get(KEY)).contributions.length, 2);
});

test("backups can never be downloaded through the public image link", async () => {
  const env = mockEnv();
  await save(env, ledger(1)); await save(env, ledger(2));
  const key = backupKeys(env)[0];
  for (const p of ["/api/pickleball/images/" + key, "/api/pickleball/images/" + encodeURIComponent(key)]) {
    assert.equal((await call(env, p)).status, 404, p);
  }
});

test("daily scheduled run makes a copy and prunes old backups", async () => {
  const env = mockEnv();
  await env.PICKLEBALL_FUND.put(KEY, JSON.stringify(ledger(3)));
  const DAY = 86400000;
  await env.MY_BUCKET.put(BACKUP_PREFIX + makeBackupId(Date.now() - 400 * DAY, "oldold") + ".json", "{}");
  await env.MY_BUCKET.put(BACKUP_PREFIX + makeBackupId(Date.now() - 5 * DAY, "recent") + ".json", "{}");
  await env.MY_BUCKET.put("1700000000000-receipt.jpg", "img"); // receipts must never be touched
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const keys = backupKeys(env);
  assert.equal(keys.length, 2, "old one pruned, recent kept, daily added");
  assert.ok(!keys.some((k) => k.includes("oldold")));
  const daily = keys.map((k) => env.MY_BUCKET.objects.get(k)).find((o) => o.customMetadata.reason === "daily");
  assert.equal(JSON.parse(daily.body).contributions.length, 3);
  assert.ok(env.MY_BUCKET.objects.has("1700000000000-receipt.jpg"));
});

test("inventory is unchanged: no backups, own password only", async () => {
  const env = mockEnv();
  const inv = (pw, body) => call(env, "/api/inventory/items", { method: "POST", password: pw, body: JSON.stringify(body) });
  assert.equal((await inv(PB_PW, [])).status, 401);
  assert.equal((await inv(INV_PW, [{ id: "a" }])).status, 200);
  assert.equal((await inv(INV_PW, [{ id: "b" }])).status, 200);
  assert.equal(env.MY_BUCKET.objects.size, 0);
  const got = await (await call(env, "/api/inventory/items")).json();
  assert.deepEqual(got, [{ id: "b" }]);
});

test("existing security still holds: uploads, other sites, static files", async () => {
  const env = mockEnv();
  assert.equal((await call(env, "/api/pickleball/upload-image", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await save(env, ledger(1), PB_PW, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(env, "/api/auth/check?app=pickleball", { method: "POST", password: PB_PW })).status, 200);
  assert.equal((await call(env, "/api/auth/check?app=pickleball", { method: "POST", password: INV_PW })).status, 401);
  assert.equal((await call(env, "/pickleball/")).status, 200, "static pages still served");
});

test("committee can delete a screenshot no longer used by the ledger", async () => {
  const env = mockEnv();
  await env.MY_BUCKET.put("1793000000000-a.jpg", "img");
  await save(env, ledger(1));
  const del = (key, opts = {}) => call(env, "/api/pickleball/images/" + key, { method: "DELETE", password: PB_PW, ...opts });
  assert.equal((await del("1793000000000-a.jpg", { password: "" })).status, 401, "no password");
  assert.equal((await del("1793000000000-a.jpg", { password: INV_PW })).status, 401, "inventory password");
  assert.equal((await del("1793000000000-a.jpg", { origin: "https://evil.example" })).status, 403, "other website");
  assert.ok(env.MY_BUCKET.objects.has("1793000000000-a.jpg"), "still there after refused deletes");
  assert.equal((await del("1793000000000-a.jpg")).status, 200);
  assert.ok(!env.MY_BUCKET.objects.has("1793000000000-a.jpg"));
  assert.equal((await call(env, "/api/pickleball/images/1793000000000-a.jpg")).status, 404);
});

test("a screenshot or receipt still used by the ledger cannot be deleted", async () => {
  const env = mockEnv();
  await env.MY_BUCKET.put("1793000000000-shot.jpg", "img");
  await env.MY_BUCKET.put("1793000000000-receipt.jpg", "img");
  await save(env, ledger(1, {
    contributions: [{ id: "g", reclub: { people: [], screenshots: ["/api/pickleball/images/1793000000000-shot.jpg"] } }],
    bookings: [{ id: "b", receiptImages: ["/api/pickleball/images/1793000000000-receipt.jpg"] }],
  }));
  for (const key of ["1793000000000-shot.jpg", "1793000000000-receipt.jpg"]) {
    const r = await call(env, "/api/pickleball/images/" + key, { method: "DELETE", password: PB_PW });
    assert.equal(r.status, 409, key);
    assert.ok(env.MY_BUCKET.objects.has(key), key + " kept");
  }
});

test("backups and odd paths can never be deleted through the image link", async () => {
  const env = mockEnv();
  await save(env, ledger(1)); await save(env, ledger(2));
  const key = backupKeys(env)[0];
  for (const p of ["/api/pickleball/images/" + key, "/api/pickleball/images/" + encodeURIComponent(key), "/api/pickleball/images/%E0%A4%A", "/api/pickleball/images/..%2F" + key]) {
    const r = await call(env, p, { method: "DELETE", password: PB_PW });
    assert.equal(r.status, 404, p);
  }
  assert.ok(env.MY_BUCKET.objects.has(key), "backup untouched");
});

test("an image only mentioned in activity-log history can be deleted", async () => {
  const env = mockEnv();
  await env.MY_BUCKET.put("1793000000000-old.jpg", "img");
  await save(env, ledger(1, {
    contributions: [{ id: "g", reclub: { people: [], screenshots: [] } }],
    activityLogs: [{ id: "l1", description: "x", snapshot: { contributions: [{ id: "g", reclub: { screenshots: ["/api/pickleball/images/1793000000000-old.jpg"] } }] } }],
  }));
  const r = await call(env, "/api/pickleball/images/1793000000000-old.jpg", { method: "DELETE", password: PB_PW });
  assert.equal(r.status, 200);
  assert.ok(!env.MY_BUCKET.objects.has("1793000000000-old.jpg"));
});
