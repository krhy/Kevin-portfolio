import { handleInventoryApi } from "./inventory-api.js";
import { handleAuthApi, requireAdmin, isAdmin, isSameOrigin, readBodyLimited, json } from "./auth.js";
import {
  BACKUP_ID_RE, saveBackup, listBackups, getBackupText, runDailyBackup,
  buildRestoredLedger, stripDeviceDetails, restoreDeviceDetails,
} from "./pickleball-backups.js";

const PICKLEBALL_KV_KEY = "pickleball:entries";

// Cloudflare KV allows values up to 25 MiB. The ledger carries 20 activity-log
// snapshots, so it is many times larger than the entries alone.
const MAX_LEDGER_BYTES = 24 * 1024 * 1024; // 24 MiB
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;  // 8 MB per receipt image

// Identify the real image type from the file's first bytes,
// instead of trusting what the uploader claims.
function detectImageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { type: "image/png", ext: "png" };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return { type: "image/gif", ext: "gif" };
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { type: "image/webp", ext: "webp" };
  return null;
}

async function handlePickleballApi(request, env) {
  const url = new URL(request.url);

  // 1. UPLOAD IMAGE TO R2 (committee only)
  if (url.pathname === "/api/pickleball/upload-image") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!isSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    const denied = await requireAdmin(request, env, "pickleball");
    if (denied) return denied;

    // base64 is ~4/3 the size of the image, plus a little JSON overhead.
    const { text, error } = await readBodyLimited(request, Math.ceil(MAX_IMAGE_BYTES * 1.4) + 1024);
    if (error) return error;

    let buffer;
    try {
      const { imageBase64 } = JSON.parse(text);
      const base64Data = String(imageBase64 || "").replace(/^data:image\/[\w.+-]+;base64,/, "");
      buffer = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    } catch {
      return json({ error: "Invalid image data" }, 400);
    }

    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      return json({ error: "Image is empty or too large" }, 413);
    }
    const kind = detectImageType(buffer);
    if (!kind) return json({ error: "Only JPEG, PNG, GIF or WebP images are allowed" }, 415);

    // Server-generated name: the uploader can't choose paths or extensions.
    const key = `${Date.now()}-${crypto.randomUUID()}.${kind.ext}`;
    await env.MY_BUCKET.put(key, buffer, { httpMetadata: { contentType: kind.type } });

    return json({ url: `/api/pickleball/images/${key}` });
  }

  // 2. SERVE IMAGE FROM R2 (public, same as before)
  if (url.pathname.startsWith("/api/pickleball/images/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed" }, 405);
    }
    const key = decodeURIComponent(url.pathname.slice("/api/pickleball/images/".length));
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(key)) {
      return new Response("Image not found", { status: 404 });
    }
    const object = await env.MY_BUCKET.get(key);
    if (!object) {
      return new Response("Image not found", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const ct = headers.get("Content-Type") || "";
    if (!/^image\/(jpeg|png|gif|webp)$/.test(ct)) headers.set("Content-Type", "application/octet-stream");
    headers.set("etag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");

    return new Response(object.body, { headers });
  }

  // 3. SERVER BACKUPS (committee only): list, preview, restore
  if (url.pathname === "/api/pickleball/backups" || url.pathname.startsWith("/api/pickleball/backups/")) {
    return handleBackupsApi(request, env, url);
  }

  // 4. CORE KV API ROUTE FOR ENTRIES
  if (url.pathname !== "/api/pickleball/entries") {
    return null;
  }

  // Reading the ledger stays public (the page is a read-only view by default),
  // but device details in the activity log are only shown to the committee.
  if (request.method === "GET") {
    const data = await env.PICKLEBALL_FUND.get(PICKLEBALL_KV_KEY);
    let body = data || "[]";
    if (data && !(await isAdmin(request, env, "pickleball"))) {
      try {
        body = JSON.stringify(stripDeviceDetails(JSON.parse(data)));
      } catch {
        body = "[]";
      }
    }
    return new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (request.method === "PUT" || request.method === "POST") {
    if (!isSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    const denied = await requireAdmin(request, env, "pickleball");
    if (denied) return denied;

    const { text, error } = await readBodyLimited(request, MAX_LEDGER_BYTES);
    if (error) return error;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Invalid ledger format" }, 400);
    }

    const current = await env.PICKLEBALL_FUND.get(PICKLEBALL_KV_KEY);
    let stored = null;
    try { stored = current ? JSON.parse(current) : null; } catch { stored = null; }
    const toSave = JSON.stringify(restoreDeviceDetails(parsed, stored));

    // Keep a copy of the previous ledger before replacing it. A failed backup
    // must not block the committee from saving, so it is logged instead.
    if (current && current !== toSave) {
      try {
        await saveBackup(env, current, "before-save");
      } catch (err) {
        console.error("Pickleball backup before save failed:", err);
      }
    }

    await env.PICKLEBALL_FUND.put(PICKLEBALL_KV_KEY, toSave);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleBackupsApi(request, env, url) {
  const denied = await requireAdmin(request, env, "pickleball");
  if (denied) return denied;

  const rest = url.pathname.slice("/api/pickleball/backups".length).replace(/^\//, "");

  // GET /api/pickleball/backups?cursor=...  -> newest first
  if (rest === "") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const cursor = url.searchParams.get("cursor") || undefined;
    return json(await listBackups(env, { cursor, limit: 30 }));
  }

  const [id, action] = rest.split("/");
  if (!BACKUP_ID_RE.test(id || "")) return json({ error: "Backup not found" }, 404);

  // GET /api/pickleball/backups/<id>  -> the backed-up ledger, for preview
  if (!action && request.method === "GET") {
    const text = await getBackupText(env, id);
    if (text === null) return json({ error: "Backup not found" }, 404);
    return new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  // POST /api/pickleball/backups/<id>/restore
  if (action === "restore" && request.method === "POST") {
    if (!isSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    const text = await getBackupText(env, id);
    if (text === null) return json({ error: "Backup not found" }, 404);
    let backup;
    try { backup = JSON.parse(text); } catch { return json({ error: "Backup is damaged" }, 422); }

    const current = await env.PICKLEBALL_FUND.get(PICKLEBALL_KV_KEY);
    let currentLedger = null;
    try { currentLedger = current ? JSON.parse(current) : null; } catch { currentLedger = null; }

    // Back up what is there now, so the restore can be undone. Unlike a normal
    // save, a restore is refused if this safety copy cannot be made.
    const undoId = current ? await saveBackup(env, current, "before-restore") : null;
    const restored = buildRestoredLedger(currentLedger, backup, id);
    await env.PICKLEBALL_FUND.put(PICKLEBALL_KV_KEY, JSON.stringify(restored));
    return json({ ok: true, undoBackupId: undoId, version: restored.version });
  }

  return json({ error: "Method not allowed" }, 405);
}

export default {
  // Daily backup + cleanup (schedule is in wrangler.jsonc "triggers").
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyBackup(env, PICKLEBALL_KV_KEY));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth/")) {
      const apiResponse = await handleAuthApi(request, env);
      if (apiResponse) return apiResponse;
    }

    if (url.pathname.startsWith("/api/pickleball/")) {
      const apiResponse = await handlePickleballApi(request, env);
      if (apiResponse) return apiResponse;
    }

    if (url.pathname.startsWith("/api/inventory/")) {
      const apiResponse = await handleInventoryApi(request, env);
      if (apiResponse) return apiResponse;
    }

    // Everything else serves static files
    return env.ASSETS.fetch(request);
  },
};
