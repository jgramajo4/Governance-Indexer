# gavel-index-api

Standalone Cloudflare Worker that exposes Gavel's public, read-only governance-index API. It is deliberately **not** part of the website Worker.

## Public surface

- Allows only `GET` and `HEAD` on paths beginning `/v1/`.
- Returns `404 {"error":"not_found"}` for every other path or HTTP method.
- Proxies allowed requests to `ORIGIN_URL` while preserving the full path and query string.
- Forwards only cache-validation/representation headers (`Accept`, `If-Modified-Since`, `If-None-Match`, `Range`). It never forwards client cookies or authorization headers.
- Removes `Server`, `Via`, `X-Powered-By`, `X-Origin-*`, and `X-Internal-*` response headers.
- Caches successful unconditioned `GET` responses that do not specify `Accept`; `HEAD`, range, conditional, and representation-negotiated requests bypass the cache to prevent variant poisoning.
- Enforces a per-IP rate limit with a Durable Object shard per IP. This is a backstop; add a Cloudflare WAF/rate-limiting rule as the outer layer.
- Rejects query strings longer than `MAX_QUERY_LENGTH`, headers larger than `MAX_HEADER_BYTES`, and any request that declares a body. The Gavel index API's current `/v1` routes are GET/HEAD-only and do not accept request bodies.
- Produces generic public errors only and logs internal errors to the Worker console.

## Cache behavior

The current governance-index routes use `limit`, `cursor`, and optional `voter` query parameters. The Worker retains the **entire query string** in both the upstream request and cache key, so pagination and filtering cannot collide. It does not invent a query allowlist.

## Required configuration

| Name | Kind | Default / recommendation | Notes |
| --- | --- | --- | --- |
| `ORIGIN_URL` | Worker secret | none — **required** | Private Cloudflare Tunnel URL added in step 3. Never commit it. |
| `CF_ACCESS_CLIENT_ID` | Worker secret | none — **required in step 3** | Access service-token client ID used only on Worker-to-origin requests. |
| `CF_ACCESS_CLIENT_SECRET` | Worker secret | none — **required in step 3** | Access service-token secret used only on Worker-to-origin requests. |
| `CACHE_TTL_SECONDS` | Worker variable | `45` | TTL for successful GET responses. |
| `MAX_REQUESTS_PER_MINUTE` | Worker variable | `120` | Per source IP, per fixed 60-second Durable Object window. |
| `MAX_QUERY_LENGTH` | Worker variable | `2048` | Maximum raw query-string length. |
| `MAX_HEADER_BYTES` | Worker variable | `16384` | Aggregate header cap measured by the Worker. |
| `RATE_LIMITER` | Durable Object binding | configured | Required binding; do not set manually. |

`ORIGIN_URL` is configured in step 3 together with `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET`. The Worker adds those secrets only to its upstream
request; it never forwards caller-supplied Access credentials.

## Local verification

```bash
cd workers/gavel-index-api
npm install
npm test
```

## Deploy after Cloudflare account setup

1. Create the Worker in your Cloudflare account and choose the public hostname (recommended: `index.gavel.vote`).
2. Configure the DNS record and Worker route in Cloudflare. Keep `workers_dev = false`.
3. Set the secret:

```bash
cd workers/gavel-index-api
npx wrangler login
npx wrangler secret put ORIGIN_URL
```

4. Review the non-secret values in `wrangler.toml`, then deploy:

```bash
npx wrangler deploy
```

5. Add a dashboard-level WAF/rate-limiting rule for `http.request.uri.path starts_with "/v1/"`. A sensible first outer limit is 300 requests/minute per IP with a one-minute mitigation timeout. The Worker enforces the tighter, configurable 120 RPM backstop.

Do **not** configure Cloudflare Access, cloudflared, or an origin-side authentication scheme in this Worker. That is step 3.
