// Server-side backups for the Pickleball Committee Fund ledger.
//
// - Every save first copies the PREVIOUS ledger into R2 (reason "before-save").
// - A daily scheduled run (see "triggers" in wrangler.jsonc) stores a "daily"
//   copy and prunes old backups.
// - Restoring a backup first copies the current ledger ("before-restore"),
//   so a restore can itself be undone.
//
// Retention: every backup from the last 90 days, plus the newest backup of
// each calendar month for 365 days. Older backups are deleted.
//
// Backups live under backups/pickleball/ in the R2 bucket. They are never
// served publicly: the public image route only accepts keys without "/".

export const BACKUP_PREFIX = "backups/pickleball/";
export const KEEP_ALL_DAYS = 90;
export const KEEP_MONTHLY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TS = 9999999999999; // 13 digits; makes newer keys sort first

// Backup ids look like "<inverted-ts>-<ts>-<random>", e.g.
// 8206485180256-1793514819743-k3x9qa. Newest sorts first in R2 listings.
export const BACKUP_ID_RE = /^\d{13}-\d{13}-[a-z0-9]{6}$/;

export function makeBackupId(ts, rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0")) {
  const inv = String(MAX_TS - ts).padStart(13, "0");
  return `${inv}-${String(ts).padStart(13, "0")}-${rand}`;
}

export function backupTime(id) {
  return Number(id.split("-")[1]);
}

function counts(ledger) {
  return {
    contributions: String((ledger.contributions || []).length),
    bookings: String((ledger.bookings || []).length),
    expenses: String((ledger.expenses || []).length),
  };
}

// Store a copy of a ledger (JSON text). Returns the backup id, or null if
// there was nothing to back up.
export async function saveBackup(env, ledgerText, reason, now = Date.now()) {
  if (!ledgerText) return null;
  let ledger;
  try {
    ledger = JSON.parse(ledgerText);
  } catch {
    ledger = {};
  }
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) ledger = {};
  const id = makeBackupId(now);
  await env.MY_BUCKET.put(BACKUP_PREFIX + id + ".json", ledgerText, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { reason, savedAt: String(now), ...counts(ledger) },
  });
  return id;
}

export async function listBackups(env, { cursor, limit = 30 } = {}) {
  const res = await env.MY_BUCKET.list({
    prefix: BACKUP_PREFIX,
    limit: Math.min(Math.max(limit, 1), 100),
    cursor: cursor || undefined,
    include: ["customMetadata"],
  });
  const items = res.objects
    .map((o) => {
      const id = o.key.slice(BACKUP_PREFIX.length).replace(/\.json$/, "");
      if (!BACKUP_ID_RE.test(id)) return null;
      const m = o.customMetadata || {};
      return {
        id,
        savedAt: backupTime(id),
        reason: m.reason || "unknown",
        contributions: Number(m.contributions || 0),
        bookings: Number(m.bookings || 0),
        expenses: Number(m.expenses || 0),
        size: o.size,
      };
    })
    .filter(Boolean);
  return { items, cursor: res.truncated ? res.cursor : null };
}

export async function getBackupText(env, id) {
  if (!BACKUP_ID_RE.test(id || "")) return null;
  const obj = await env.MY_BUCKET.get(BACKUP_PREFIX + id + ".json");
  return obj ? await obj.text() : null;
}

// Decide which backups to delete. Pure function so it can be unit tested.
// ids: backup ids (any order). Returns the ids to delete.
export function selectBackupsToPrune(ids, now = Date.now()) {
  const keepAllAfter = now - KEEP_ALL_DAYS * DAY_MS;
  const keepMonthlyAfter = now - KEEP_MONTHLY_DAYS * DAY_MS;
  const newestFirst = [...ids].filter((id) => BACKUP_ID_RE.test(id)).sort((a, b) => backupTime(b) - backupTime(a));
  const monthsKept = new Set();
  const toDelete = [];
  for (const id of newestFirst) {
    const t = backupTime(id);
    if (t >= keepAllAfter) continue; // recent: keep everything
    if (t >= keepMonthlyAfter) {
      const month = new Date(t).toISOString().slice(0, 7); // YYYY-MM (UTC)
      if (!monthsKept.has(month)) {
        monthsKept.add(month); // newest backup of that month
        continue;
      }
    }
    toDelete.push(id);
  }
  return toDelete;
}

export async function pruneBackups(env, now = Date.now()) {
  const ids = [];
  let cursor;
  do {
    const res = await env.MY_BUCKET.list({ prefix: BACKUP_PREFIX, limit: 1000, cursor });
    for (const o of res.objects) ids.push(o.key.slice(BACKUP_PREFIX.length).replace(/\.json$/, ""));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  const toDelete = selectBackupsToPrune(ids, now);
  for (let i = 0; i < toDelete.length; i += 1000) {
    await env.MY_BUCKET.delete(toDelete.slice(i, i + 1000).map((id) => BACKUP_PREFIX + id + ".json"));
  }
  return toDelete.length;
}

// Daily scheduled run: store a copy, then prune old copies.
export async function runDailyBackup(env, kvKey, now = Date.now()) {
  const current = await env.PICKLEBALL_FUND.get(kvKey);
  const id = await saveBackup(env, current, "daily", now);
  const pruned = await pruneBackups(env, now);
  return { id, pruned };
}

const MAX_LOGS = 20;

// Build the ledger that a restore will save: the backup's entries, the
// CURRENT activity log (so the audit trail of what happened is kept), plus a
// log entry describing the restore.
export function buildRestoredLedger(currentLedger, backupLedger, backupId, now = Date.now()) {
  const cur = currentLedger && typeof currentLedger === "object" && !Array.isArray(currentLedger) ? currentLedger : {};
  const bak = backupLedger && typeof backupLedger === "object" && !Array.isArray(backupLedger) ? backupLedger : {};
  const restored = {
    contributions: bak.contributions || [],
    bookings: bak.bookings || [],
    expenses: bak.expenses || [],
  };
  const when = new Date(backupTime(backupId)).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const entry = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 7),
    timestamp: now,
    deviceId: "server",
    userAgent: "Server backup restore",
    environment: {},
    description: `Restored server backup from ${when}`,
    snapshot: JSON.parse(JSON.stringify(restored)),
  };
  return {
    ...restored,
    activityLogs: [entry, ...(cur.activityLogs || [])].slice(0, MAX_LOGS),
    version: Math.max(Number(cur.version) || 1, Number(bak.version) || 1) + 1,
    lastModified: now,
  };
}

// ---- Device details (D) ----

const PRIVATE_LOG_FIELDS = ["deviceId", "userAgent", "environment"];

// Remove device details from activity logs for public (not unlocked) viewers.
export function stripDeviceDetails(ledger) {
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.activityLogs)) return ledger;
  return {
    ...ledger,
    activityLogs: ledger.activityLogs.map((log) => {
      if (!log || typeof log !== "object") return log;
      const copy = { ...log };
      for (const f of PRIVATE_LOG_FIELDS) delete copy[f];
      return copy;
    }),
  };
}

// A browser that loaded the public (stripped) view may save logs without
// device details. Put the stored details back so they are never lost.
export function restoreDeviceDetails(incoming, stored) {
  if (!incoming || !Array.isArray(incoming.activityLogs)) return incoming;
  const byId = new Map();
  for (const log of (stored && stored.activityLogs) || []) {
    if (log && log.id) byId.set(log.id, log);
  }
  incoming.activityLogs = incoming.activityLogs.map((log) => {
    const old = log && byId.get(log.id);
    if (!old) return log;
    const merged = { ...log };
    for (const f of PRIVATE_LOG_FIELDS) {
      if (merged[f] === undefined && old[f] !== undefined) merged[f] = old[f];
    }
    return merged;
  });
  return incoming;
}
