export async function onRequestGet(context) {
  try {
    const data = await context.env.INVENTORY_KV.get('app_data');
    return new Response(data || '[]', {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.text();
    JSON.parse(body); // Validate JSON payload
    await context.env.INVENTORY_KV.put('app_data', body);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: 'Invalid data' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
