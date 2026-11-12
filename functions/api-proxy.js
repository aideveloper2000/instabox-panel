export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Only proxy /api/* paths
    if (!pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // Extract target path after /api/
    const targetPath = pathname.slice(4); // remove "/api"
    const targetUrl = `https://api.instabox.sh${targetPath}${url.search}`;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization, Idempotency-Key, X-Target-URL",
      "Access-Control-Max-Age": "86400",
    };

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Forward request to Instabox API
    const requestHeaders = new Headers(request.headers);
    // Ensure we forward the API key
    const apiKey = requestHeaders.get("X-API-Key") || requestHeaders.get("Authorization");
    
    const forwardHeaders = new Headers();
    forwardHeaders.set("Content-Type", "application/json");
    if (apiKey) {
      forwardHeaders.set("X-API-Key", apiKey.replace("Bearer ", ""));
    }
    // Forward idempotency key if present
    const idempotencyKey = requestHeaders.get("Idempotency-Key");
    if (idempotencyKey) {
      forwardHeaders.set("Idempotency-Key", idempotencyKey);
    }

    const forwardRequest = new Request(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "follow",
    });

    try {
      const response = await fetch(forwardRequest);
      
      // Return response with CORS headers
      const responseHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => responseHeaders.set(k, v));
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Proxy error", message: err.message }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};