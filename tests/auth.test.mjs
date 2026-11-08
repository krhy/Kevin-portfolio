import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAdmin, isAdmin, isSameOrigin, makeSessionToken, checkSessionToken, handleAuthApi, SESSION_DAYS } from "../auth.js";
import { mockEnv, req, PB_PW, INV_PW } from "./helpers.mjs";

test("each app accepts only its own password", async () => {
  const env = mockEnv();
  assert.equal(await isAdmin(req("/", { password: PB_PW }), env, "pickleball"), true);
  assert.equal(await isAdmin(req("/", { password: INV_PW }), env, "pickleball"), false);
  assert.equal(await isAdmin(req("/", { password: INV_PW }), env, "inventory"), true);
  assert.equal(await isAdmin(req("/", { password: PB_PW }), env, "inventory"), false);
  assert.equal(await isAdmin(req("/"), env, "pickleball"), false);
});

test("unknown app names never authorize (including prototype keys)", async () => {
  const env = mockEnv();
  for (const app of ["__proto__", "constructor", "toString", "", undefined]) {
    assert.equal(await isAdmin(req("/", { password: PB_PW }), env, app), false);
    assert.equal((await requireAdmin(req("/", { password: PB_PW }), env, app)).status, 503);
  }
});

test("missing secret fails closed", async () => {
  const env = mockEnv({ PICKLEBALL_PASSWORD: undefined });
  const r = await requireAdmin(req("/", { password: "" }), env, "pickleball");
  assert.equal(r.status, 503);
  assert.equal(await isAdmin(req("/", { password: "anything" }), env, "pickleball"), false);
});

test("wrong or empty password is 401, right password passes", async () => {
  const env = mockEnv();
  assert.equal((await requireAdmin(req("/", { password: "nope" }), env, "pickleball")).status, 401);
  assert.equal((await requireAdmin(req("/"), env, "pickleball")).status, 401);
  assert.equal(await requireAdmin(req("/", { password: PB_PW }), env, "pickleball"), null);
});

test("same-origin check", () => {
  assert.equal(isSameOrigin(req("/", { origin: "https://kevinrhys.com" })), true);
  assert.equal(isSameOrigin(req("/", { origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(req("/")), true);
});

const DAY = 24 * 60 * 60 * 1000;
const keyReq = (token) => req("/", { headers: { "X-Admin-Token": token } });

test("unlocking with the password returns a 7-day key; the key then works", async () => {
  const env = mockEnv();
  const r = await handleAuthApi(req("/api/auth/check?app=pickleball", { method: "POST", password: PB_PW }), env);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.ok(body.token && !body.token.includes(PB_PW), "key never contains the password");
  assert.ok(Math.abs(body.expires - (Date.now() + SESSION_DAYS * DAY)) < 5000, "expires in 7 days");
  assert.equal(SESSION_DAYS, 7);
  assert.equal(await requireAdmin(keyReq(body.token), env, "pickleball"), null);
  assert.equal(await isAdmin(keyReq(body.token), env, "pickleball"), true);
  const again = await (await handleAuthApi(req("/api/auth/check?app=pickleball", { method: "POST", headers: { "X-Admin-Token": body.token } }), env)).json();
  assert.equal(again.token, undefined, "checking a key does not hand out a new one");
  assert.equal(again.expires, body.expires);
});

test("keys stop working when expired, tampered, for another app, or after a password change", async () => {
  const env = mockEnv();
  const { token } = await makeSessionToken(PB_PW, "pickleball");
  const [a, e, sig] = token.split(".");
  assert.equal((await requireAdmin(keyReq(token), env, "inventory")).status, 401, "pickleball key can't unlock inventory");
  assert.equal((await requireAdmin(keyReq(`${a}.${Number(e) + DAY}.${sig}`), env, "pickleball")).status, 401, "extended expiry");
  assert.equal((await requireAdmin(keyReq(`inventory.${e}.${sig}`), env, "inventory")).status, 401, "swapped app");
  assert.equal((await requireAdmin(keyReq(`${a}.${e}.${sig.slice(0, -2)}xx`), env, "pickleball")).status, 401, "changed signature");
  assert.equal((await requireAdmin(keyReq("junk"), env, "pickleball")).status, 401);
  const old = await makeSessionToken(PB_PW, "pickleball", Date.now() - 8 * DAY);
  assert.equal(await checkSessionToken(PB_PW, "pickleball", old.token), 0, "8-day-old key expired");
  const changed = mockEnv({ PICKLEBALL_PASSWORD: "a-new-password" });
  assert.equal((await requireAdmin(keyReq(token), changed, "pickleball")).status, 401, "password change signs everyone out");
  const far = await makeSessionToken(PB_PW, "pickleball", Date.now() + 30 * DAY);
  assert.equal(await checkSessionToken(PB_PW, "pickleball", far.token), 0, "keys can't be made to last longer than 7 days");
});
