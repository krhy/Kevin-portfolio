const INVENTORY_KV_KEY = "inventory:items";

export async function handleInventoryApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== "/api/inventory/items") {
    return null; // not our route
  }

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (request.method === "GET") {
    const data = await env.INVENTORY_KV.get(INVENTORY_KV_KEY);
    return new Response(data || "[]", { headers: corsHeaders });
  }

  if (request.method === "POST" || request.method === "PUT") {
    let body;
    try {
      body = await request.text();
      JSON.parse(body); // validate before storing
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    await env.INVENTORY_KV.put(INVENTORY_KV_KEY, body);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
}
