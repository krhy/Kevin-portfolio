import { handleInventoryApi } from "./inventory-api.js";
import { handleAuthApi, requireAdmin, isSameOrigin, readBodyLimited, json } from "./auth.js";

const PICKLEBALL_KV_KEY = "pickleball:entries";

const MAX_LEDGER_BYTES = 5 * 1024 * 1024; // 5 MB
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

  // 3. CORE KV API ROUTE FOR ENTRIES
  if (url.pathname !== "/api/pickleball/entries") {
    return null;
  }

  // Reading the ledger stays public (the page is a read-only view by default).
  if (request.method === "GET") {
    const data = await env.PICKLEBALL_FUND.get(PICKLEBALL_KV_KEY);
    return new Response(data || "[]", {
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

    await env.PICKLEBALL_FUND.put(PICKLEBALL_KV_KEY, text);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

export default {
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
