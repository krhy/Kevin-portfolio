// In-memory stand-ins for Cloudflare KV and R2, used by the unit tests.

export function mockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
  };
}

export function mockR2() {
  const objects = new Map(); // key -> { body, httpMetadata, customMetadata }
  return {
    objects,
    async put(key, value, opts = {}) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: o.body,
        httpEtag: '"etag"',
        customMetadata: o.customMetadata,
        async text() { return o.body; },
        writeHttpMetadata(h) { if (o.httpMetadata.contentType) h.set("Content-Type", o.httpMetadata.contentType); },
      };
    },
    async list({ prefix = "", limit = 1000, cursor, include = [] } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((key) => ({
          key,
          size: objects.get(key).body.length,
          ...(include.includes("customMetadata") ? { customMetadata: objects.get(key).customMetadata } : {}),
        })),
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
      };
    },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
  };
}

export const PB_PW = "pickle-test-pw";
export const INV_PW = "inventory-test-pw";

export function mockEnv(extra = {}) {
  return {
    PICKLEBALL_FUND: mockKV(),
    INVENTORY_KV: mockKV(),
    MY_BUCKET: mockR2(),
    PICKLEBALL_PASSWORD: PB_PW,
    INVENTORY_PASSWORD: INV_PW,
    ASSETS: { fetch: async () => new Response("static asset", { status: 200 }) },
    ...extra,
  };
}

export const ORIGIN = "https://kevinrhys.com";

export function req(path, { method = "GET", password, body, origin, headers = {} } = {}) {
  const h = new Headers(headers);
  if (password) h.set("X-Admin-Password", password);
  if (origin) h.set("Origin", origin);
  return new Request(ORIGIN + path, { method, headers: h, body });
}

export function ledger(n = 1, extra = {}) {
  return {
    contributions: Array.from({ length: n }, (_, i) => ({ id: "c" + i, date: "2026-10-0" + (i % 9 + 1), feePerPerson: 150, players: 10, ccSpent: 1200 })),
    bookings: [],
    expenses: [],
    activityLogs: [],
    version: 1,
    lastModified: 1,
    ...extra,
  };
}
