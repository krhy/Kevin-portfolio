const PICKLEBALL_KV_KEY = "pickleball:entries";

async function handlePickleballApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== "/api/pickleball/entries") {
    return null; // not our route
  }

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (request.method === "GET") {
    const data = await env.PICKLEBALL_FUND.get(PICKLEBALL_KV_KEY);
    return new Response(data || "[]", { headers: corsHeaders });
  }

  if (request.method === "PUT") {
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

    // Everything else (index.html, about.html, system.html, pickleball/index.html,
    // the resume PDF, the logo image) is served as-is from the repo's static files.
    return env.ASSETS.fetch(request);
  },
};
