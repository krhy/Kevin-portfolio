// Password checks for the pickleball and inventory APIs.
//
// Each app has its OWN password, and neither is stored in this repo.
// They are read from these Cloudflare secrets:
//   PICKLEBALL_PASSWORD  - Pickleball Committee Fund editors
//   INVENTORY_PASSWORD   - Inventory & Sales editors
// Set them in the Cloudflare dashboard (Worker > Settings > Variables and
// Secrets) or with:  npx wrangler secret put PICKLEBALL_PASSWORD
//
// If an app's secret is missing, every write to that app is refused (fail closed).

// Which secret protects which app.
export const APP_SECRETS = {
  pickleball: "PICKLEBALL_PASSWORD",
  inventory: "INVENTORY_PASSWORD",
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// Compare fixed-length hashes in constant time so response timing
// doesn't leak how much of the password was correct.
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// ---- "Stay unlocked": signed session keys --------------------------------
// After the password is checked once, the phone gets a key that is valid for
// SESSION_DAYS. The key is signed with the app's password, so changing the
// password in Cloudflare instantly invalidates every key. Phones store the
// key, never the password.
export const SESSION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode("session-key:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

export async function makeSessionToken(secret, app, now = Date.now()) {
  const expires = now + SESSION_DAYS * DAY_MS;
  const body = `${app}.${expires}`;
  return { token: `${body}.${await sign(secret, body)}`, expires };
}

// Returns the expiry time if the key is valid for this app, else 0.
export async function checkSessionToken(secret, app, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return 0;
  const [tApp, tExp, tSig] = parts;
  const expires = Number(tExp);
  if (tApp !== app || !Number.isFinite(expires)) return 0;
  if (expires <= now || expires > now + SESSION_DAYS * DAY_MS + 60 * 1000) return 0;
  return (await safeEqual(tSig, await sign(secret, `${tApp}.${tExp}`))) ? expires : 0;
}

// How the request is unlocked: { method: "password" } or { method: "key", expires } or null.
async function authOf(request, env, app) {
  const secretName = Object.hasOwn(APP_SECRETS, app) ? APP_SECRETS[app] : null;
  const expected = secretName && env[secretName];
  if (!expected) return null;
  const pw = request.headers.get("X-Admin-Password") || "";
  if (pw && (await safeEqual(pw, expected))) return { method: "password" };
  const key = request.headers.get("X-Admin-Token") || "";
  if (key) {
    const expires = await checkSessionToken(expected, app, key);
    if (expires) return { method: "key", expires };
  }
  return null;
}

// Returns null when the request is authorized, or an error Response otherwise.
export async function requireAdmin(request, env, app) {
  const secretName = Object.hasOwn(APP_SECRETS, app) ? APP_SECRETS[app] : null;
  const expected = secretName && env[secretName];
  if (!expected) {
    return json({ error: `Editing is disabled: ${secretName || "app"} secret is not set.` }, 503);
  }
  if (!(await authOf(request, env, app))) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

// True when the request carries the correct password or a valid key for this app.
// Never returns an error response; used where unlocking is optional.
export async function isAdmin(request, env, app) {
  return Boolean(await authOf(request, env, app));
}

// Blocks writes that come from other websites (basic CSRF protection).
// Browsers always send Origin on cross-site POST/PUT requests.
export function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // same-origin fetches from older browsers / non-browser tools
  return origin === new URL(request.url).origin;
}

// POST /api/auth/check?app=pickleball|inventory — checks the password (and returns a
// 7-day key) or checks a key (returns when it expires).
export async function handleAuthApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/check") return null;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const app = url.searchParams.get("app");
  if (!Object.hasOwn(APP_SECRETS, app || "")) return json({ error: "Unknown app" }, 400);
  const denied = await requireAdmin(request, env, app);
  if (denied) return denied;
  const how = await authOf(request, env, app);
  if (how.method === "password") {
    // Password checked: hand out a key so this phone stays unlocked for a while.
    const { token, expires } = await makeSessionToken(env[APP_SECRETS[app]], app);
    return json({ ok: true, token, expires });
  }
  return json({ ok: true, expires: how.expires }); // a key was checked: no renewal

}

// Reads a request body as text, refusing anything larger than maxBytes.
export async function readBodyLimited(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) return { error: json({ error: "Payload too large" }, 413) };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { error: json({ error: "Payload too large" }, 413) };
  }
  return { text };
}
