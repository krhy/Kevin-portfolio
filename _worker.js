import { handleInventoryApi } from "./inventory-api.js";

const PICKLEBALL_KV_KEY = "pickleball:entries";

async function handlePickleballApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== "/api/pickleball/entries") {
    return null; 
  }

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (request.method === "GET") {
    const data = await env.PICKLEBALL_FUND.get(PICKLEBALL_KV_KEY);
    return new Response(data || "[]", { headers: corsHeaders });
  }

  if (request.method === "PUT" || request.method === "POST") {
    let body;
    try {
      body = await request.text();
      JSON.parse(body); 
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    await env.PICKLEBALL_FUND.put(PICKLEBALL_KV_KEY, body);
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
