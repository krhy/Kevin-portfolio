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

// Returns null when the request is authorized, or an error Response otherwise.
export async function requireAdmin(request, env, app) {
  const secretName = Object.hasOwn(APP_SECRETS, app) ? APP_SECRETS[app] : null;
  const expected = secretName && env[secretName];
  if (!expected) {
    return json({ error: `Editing is disabled: ${secretName || "app"} secret is not set.` }, 503);
  }
  const given = request.headers.get("X-Admin-Password") || "";
  if (!given || !(await safeEqual(given, expected))) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

// Blocks writes that come from other websites (basic CSRF protection).
// Browsers always send Origin on cross-site POST/PUT requests.
export function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // same-origin fetches from older browsers / non-browser tools
  return origin === new URL(request.url).origin;
}

// POST /api/auth/check?app=pickleball|inventory  — lets the login screen verify the password.
export async function handleAuthApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/check") return null;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  const app = url.searchParams.get("app");
  if (!Object.hasOwn(APP_SECRETS, app || "")) return json({ error: "Unknown app" }, 400);
  const denied = await requireAdmin(request, env, app);
  return denied || json({ ok: true });
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
