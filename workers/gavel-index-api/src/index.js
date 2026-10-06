const DEFAULT_CACHE_TTL_SECONDS = 45;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 120;
const DEFAULT_MAX_QUERY_LENGTH = 2_048;
const DEFAULT_MAX_HEADER_BYTES = 16_384;
const WINDOW_MS = 60_000;

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "if-modified-since",
  "if-none-match",
  "range",
];

const STRIPPED_RESPONSE_HEADERS = [
  "server",
  "via",
  "x-powered-by",
  "x-origin-host",
  "x-internal-host",
  "set-cookie",
  "cf-access-jwt-assertion",
];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function isAllowedRoute(request) {
  const url = new URL(request.url);
  return (request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/v1/");
}

function headerByteLength(headers) {
  let total = 0;
  for (const [name, value] of headers) total += new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength;
  return total;
}

function originRequest(request, originUrl, accessClientId, accessClientSecret) {
  const origin = new URL(originUrl);
  const incoming = new URL(request.url);
  origin.pathname = `${origin.pathname.replace(/\/$/, "")}${incoming.pathname}`;
  origin.search = incoming.search;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // These credentials are Worker secrets for the private Access-protected
  // origin. They are never accepted from or exposed to public callers.
  if (accessClientId && accessClientSecret) {
    headers.set("CF-Access-Client-Id", accessClientId);
    headers.set("CF-Access-Client-Secret", accessClientSecret);
  }
  return new Request(origin, { method: request.method, headers, redirect: "manual" });
}

function publicResponse(response, cacheTtlSeconds) {
  const headers = new Headers(response.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const [name] of headers) {
    if (name.startsWith("x-internal-") || name.startsWith("x-origin-") || name.startsWith("cf-access-")) headers.delete(name);
  }
  headers.set("cache-control", `public, max-age=${cacheTtlSeconds}, s-maxage=${cacheTtlSeconds}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function cacheKey(request) {
  const url = new URL(request.url);
  return new Request(`${url.origin}${url.pathname}${url.search}`, { method: "GET" });
}

function isCacheableRequest(request) {
  return request.method === "GET"
    && !request.headers.has("accept")
    && !request.headers.has("range")
    && !request.headers.has("if-modified-since")
    && !request.headers.has("if-none-match");
}

export function createWorker({ fetchImpl = fetch, cache = globalThis.caches?.default, now = Date.now, log = console } = {}) {
  return {
    async fetch(request, env) {
      if (!isAllowedRoute(request)) return json(404, { error: "not_found" });

      const maxQueryLength = positiveInteger(env.MAX_QUERY_LENGTH, DEFAULT_MAX_QUERY_LENGTH);
      if (new URL(request.url).search.length > maxQueryLength) return json(414, { error: "query_too_large" });

      const maxHeaderBytes = positiveInteger(env.MAX_HEADER_BYTES, DEFAULT_MAX_HEADER_BYTES);
      if (headerByteLength(request.headers) > maxHeaderBytes) return json(431, { error: "headers_too_large" });

      if (Number(request.headers.get("content-length") || 0) > 0) return json(400, { error: "request_body_not_allowed" });

      const rateLimit = positiveInteger(env.MAX_REQUESTS_PER_MINUTE, DEFAULT_MAX_REQUESTS_PER_MINUTE);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      try {
        const rateLimiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
        const response = await rateLimiter.fetch("https://rate-limiter/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: rateLimit, now: now() }),
        });
        if (!response.ok) throw new Error(`rate limiter returned ${response.status}`);
        const result = await response.json();
        if (!result.allowed) return json(429, { error: "rate_limited" }, { "retry-after": String(result.retryAfterSeconds) });
      } catch (error) {
        log.error("rate_limit_error", { message: String(error?.message || error) });
        return json(503, { error: "service_unavailable" });
      }

      let upstream;
      try {
        upstream = originRequest(request, env.ORIGIN_URL, env.CF_ACCESS_CLIENT_ID, env.CF_ACCESS_CLIENT_SECRET);
      } catch (error) {
        log.error("origin_configuration_error", { message: String(error?.message || error) });
        return json(503, { error: "service_unavailable" });
      }

      const cacheTtlSeconds = positiveInteger(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS);
      const key = cacheKey(request);
      const shouldCache = isCacheableRequest(request);
      if (shouldCache) {
        const cached = await cache.match(key);
        if (cached) return cached;
      }

      try {
        const response = await fetchImpl(upstream);
        if (response.status >= 300 && response.status < 400) {
          log.error("origin_redirect", { method: request.method, path: new URL(request.url).pathname, status: response.status });
          return json(502, { error: "upstream_unavailable" });
        }
        const sanitized = publicResponse(response, cacheTtlSeconds);
        if (shouldCache && sanitized.status === 200) await cache.put(key, sanitized.clone());
        return sanitized;
      } catch (error) {
        log.error("origin_request_error", { method: request.method, path: new URL(request.url).pathname, message: String(error?.message || error) });
        return json(502, { error: "upstream_unavailable" });
      }
    },
  };
}

export class RateLimiter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") return new Response(null, { status: 404 });
    const { limit, now = Date.now() } = await request.json();
    const current = await this.ctx.storage.get("window");
    const window = !current || now >= current.startedAt + WINDOW_MS
      ? { startedAt: now, count: 0 }
      : current;
    window.count += 1;
    await this.ctx.storage.put("window", window);
    const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1_000));
    return Response.json({ allowed: window.count <= limit, retryAfterSeconds });
  }
}

export default createWorker();
