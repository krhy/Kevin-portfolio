import { json, requireAdmin, isSameOrigin, readBodyLimited } from "./auth.js";

const INVENTORY_KV_KEY = "inventory:items";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export async function handleInventoryApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== "/api/inventory/items") {
    return null; // not our route
  }

  // Reading the inventory stays public (the page is a read-only view by default).
  if (request.method === "GET") {
    const data = await env.INVENTORY_KV.get(INVENTORY_KV_KEY);
    return new Response(data || "[]", {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (request.method === "POST" || request.method === "PUT") {
    if (!isSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    const denied = await requireAdmin(request, env, "inventory");
    if (denied) return denied;

    const { text, error } = await readBodyLimited(request, MAX_BODY_BYTES);
    if (error) return error;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!Array.isArray(parsed)) {
      return json({ error: "Inventory must be a list of items" }, 400);
    }

    await env.INVENTORY_KV.put(INVENTORY_KV_KEY, text);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
