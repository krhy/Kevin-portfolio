import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeBackupId, backupTime, BACKUP_ID_RE, selectBackupsToPrune, buildRestoredLedger,
  stripDeviceDetails, restoreDeviceDetails,
} from "../pickleball-backups.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01

test("backup ids are valid, carry their time, and newer ids sort first", () => {
  const older = makeBackupId(NOW - 1000, "aaaaaa");
  const newer = makeBackupId(NOW, "bbbbbb");
  assert.match(older, BACKUP_ID_RE);
  assert.equal(backupTime(newer), NOW);
  assert.deepEqual([older, newer].sort(), [newer, older]);
});

test("backup id pattern rejects paths and junk", () => {
  for (const bad of ["../x", "a/b", "", "123", makeBackupId(NOW) + "/x", "1-2-abcdef"]) {
    assert.equal(BACKUP_ID_RE.test(bad), false, bad);
  }
});

test("pruning keeps all of the last 90 days", () => {
  const ids = [0, 1, 30, 89].map((d, i) => makeBackupId(NOW - d * DAY, "aaaaa" + i));
  assert.deepEqual(selectBackupsToPrune(ids, NOW), []);
});

test("pruning keeps the newest backup per month between 90 and 365 days", () => {
  // Three backups in the same month ~120 days ago, one ~200 days ago.
  const a = makeBackupId(Date.UTC(2026, 6, 3), "aaaaaa"); // Jul 3
  const b = makeBackupId(Date.UTC(2026, 6, 10), "bbbbbb"); // Jul 10
  const c = makeBackupId(Date.UTC(2026, 6, 20), "cccccc"); // Jul 20 (newest in July)
  const d = makeBackupId(Date.UTC(2026, 3, 15), "dddddd"); // Apr 15 (only one in April)
  const del = selectBackupsToPrune([a, b, c, d], NOW);
  assert.deepEqual(new Set(del), new Set([a, b]));
});

test("pruning deletes everything older than a year and ignores invalid ids", () => {
  const old = makeBackupId(NOW - 400 * DAY, "aaaaaa");
  const recent = makeBackupId(NOW - 2 * DAY, "bbbbbb");
  assert.deepEqual(selectBackupsToPrune([old, recent, "not-a-backup"], NOW), [old]);
});

test("restore uses the backup's entries but keeps the current activity log", () => {
  const current = {
    contributions: [{ id: "bad" }], bookings: [], expenses: [],
    activityLogs: Array.from({ length: 20 }, (_, i) => ({ id: "log" + i, description: "x" + i })),
    version: 7,
  };
  const backup = { contributions: [{ id: "good" }], bookings: [{ id: "b1" }], expenses: [], activityLogs: [{ id: "oldlog" }], version: 3 };
  const id = makeBackupId(NOW - DAY, "abcdef");
  const out = buildRestoredLedger(current, backup, id, NOW);
  assert.deepEqual(out.contributions, [{ id: "good" }]);
  assert.deepEqual(out.bookings, [{ id: "b1" }]);
  assert.equal(out.activityLogs.length, 20, "log capped at 20");
  assert.match(out.activityLogs[0].description, /^Restored server backup from 2026-10-31/);
  assert.deepEqual(out.activityLogs[0].snapshot.contributions, [{ id: "good" }]);
  assert.equal(out.activityLogs[1].id, "log0", "current log kept after restore entry");
  assert.equal(out.version, 8, "version moves forward so other open pages notice");
  assert.equal(out.lastModified, NOW);
});

test("restore copes with empty or damaged current data", () => {
  const out = buildRestoredLedger(null, { contributions: [{ id: "g" }] }, makeBackupId(NOW), NOW);
  assert.equal(out.contributions.length, 1);
  assert.equal(out.activityLogs.length, 1);
  assert.equal(out.version, 2);
});

test("device details are removed for the public, without changing the original", () => {
  const l = { activityLogs: [{ id: "1", description: "Added", deviceId: "dev_x", userAgent: "iPhone", environment: { tz: "Asia/Manila" }, snapshot: {} }] };
  const pub = stripDeviceDetails(l);
  assert.deepEqual(Object.keys(pub.activityLogs[0]).sort(), ["description", "id", "snapshot"]);
  assert.equal(l.activityLogs[0].deviceId, "dev_x", "original untouched");
});

test("saving a public (stripped) copy keeps the stored device details", () => {
  const stored = { activityLogs: [{ id: "1", deviceId: "dev_x", userAgent: "iPhone", environment: { a: 1 } }] };
  const incoming = { activityLogs: [{ id: "2", description: "new", deviceId: "dev_new" }, { id: "1", description: "old" }] };
  const out = restoreDeviceDetails(incoming, stored);
  assert.equal(out.activityLogs[0].deviceId, "dev_new", "new entries keep their own details");
  assert.equal(out.activityLogs[1].deviceId, "dev_x");
  assert.equal(out.activityLogs[1].userAgent, "iPhone");
  assert.deepEqual(out.activityLogs[1].environment, { a: 1 });
});
