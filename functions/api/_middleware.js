/**
 * Instabox Panel — same-origin API proxy (Cloudflare Pages Functions).
 *
 * The public Instabox API does not send CORS headers, so a browser cannot call
 * it directly from this site. This catch-all function forwards every /api/*
 * request server-side and adds permissive CORS headers, which makes each REST
 * call same-origin from the visitor's point of view. The API key travels in
 * the request headers, exactly as it would directly, and is never stored here.
 *
 * File: functions/api/[...path].js
 *   GET  /api/health   -> liveness probe used by the UI
 *   *    /api/v1/...   -> https://api.instabox.sh/v1/...
 *
 * Pages Functions file routing recognises named onRequest* exports; a plain
 * `export default { fetch }` is not picked up by the file-based router.
 */

const UPSTREAM = "https://api.instabox.sh";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers":
    "Content-Type, X-API-Key, Authorization, Idempotency-Key, X-Confirm-Delete, Accept",
  "Access-Control-Expose-Headers": "Retry-After, Warning",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: JSON_HEADERS });
}

export async function onRequest(context) {
  // Pages middleware receives a context object; module handlers receive the
  // request directly. Support both so the file works in either position.
  const request = context.request || context;
  const url = new URL(request.url);

  if (url.pathname === "/api/health" || url.pathname === "/api/health/") {
    return json({ ok: true, service: "instabox-panel-proxy" });
  }

  // Preflight: answer directly so the browser's check succeeds.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // "/api/v1/machines" -> "https://api.instabox.sh/v1/machines"
  const target = UPSTREAM + url.pathname.slice(4) + url.search;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const accept = request.headers.get("accept");
  if (accept) headers.set("Accept", accept);

  const apiKey =
    request.headers.get("X-API-Key") || request.headers.get("Authorization");
  if (apiKey) {
    headers.set("X-API-Key", apiKey.replace(/^Bearer\s+/i, "").trim());
  }

  for (const name of ["Idempotency-Key", "X-Confirm-Delete"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let body;
  if (!["GET", "HEAD"].includes(request.method)) {
    body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "follow",
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return json(
      {
        error: {
          code: "proxy_error",
          message: `The panel proxy could not reach ${UPSTREAM}: ${err.message}`,
          retryable: true,
        },
      },
      { status: 502 }
    );
  }
}
