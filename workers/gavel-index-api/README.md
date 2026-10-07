# gavel-index-api

Standalone Cloudflare Worker that exposes Gavel's public, read-only governance-index API. It is deliberately **not** part of the website Worker.

## Public surface

- Allows only `GET`, `HEAD` and `OPTIONS` on paths beginning `/v1/`. `OPTIONS` is passed through so the Node Index API answers CORS preflight; the Worker never fabricates one.
- Returns `404 {"error":"not_found"}` for every other path or HTTP method (including `OPTIONS` outside `/v1/`).
- Proxies allowed requests to `ORIGIN_URL` while preserving the full path and query string.
- Forwards only cache-validation/representation headers (`Accept`, `If-Modified-Since`, `If-None-Match`, `Range`), plus `Origin` unchanged when the caller sent one, plus `Access-Control-Request-Method` / `Access-Control-Request-Headers` on `OPTIONS`. It never synthesizes an `Origin` and never forwards client cookies or authorization headers.
- Removes `Server`, `Via`, `X-Powered-By`, `X-Origin-*`, and `X-Internal-*` response headers.
- Caches successful unconditioned `GET` responses that do not specify `Accept`; `HEAD`, range, conditional, and representation-negotiated requests bypass the cache to prevent variant poisoning.
- Enforces a per-IP rate limit with a Durable Object shard per IP. This is a backstop; add a Cloudflare WAF/rate-limiting rule as the outer layer.
- Rejects query strings longer than `MAX_QUERY_LENGTH`, headers larger than `MAX_HEADER_BYTES`, and any request that declares a body. The Gavel index API's current `/v1` routes are GET/HEAD-only and do not accept request bodies.
- Produces generic public errors only and logs internal errors to the Worker console.

## Cache behavior

The current governance-index routes use `limit`, `cursor`, and optional `voter` query parameters. The Worker retains the **entire query string** in both the upstream request and cache key, so pagination and filtering cannot collide. It does not invent a query allowlist.

Every Worker-proxied response carries `x-gavel-edge-cache: HIT | MISS | BYPASS` for verification.

## Browser CORS at the edge

The Node Index API (`GAVEL_INDEX_CORS_ORIGINS`, see `docs/API.md`) is the **only** CORS policy. The Worker keeps no Origin allowlist; it is transparent with respect to `Origin`:

- **Origin forwarding.** `Origin` is forwarded byte-for-byte. Requests without it remain ordinary machine requests; no `Origin` is ever added.
- **Response headers.** `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` and `Vary` returned by the Node API pass through unchanged, including on 400/404/405/500. The Worker never adds `Access-Control-Allow-Origin` or `Access-Control-Allow-Credentials`, and never replaces an exact ACAO with `*`. It does append `Origin` to `Vary` if the upstream omitted it, because the edge response itself depends on `Origin`.
- **Cache invariant.** Requests carrying `Origin`, and every `OPTIONS`, **never read or write the shared URL-only Worker cache**. They always reach the Node API and keep its `Cache-Control` (`no-store`; the Worker fills in `no-store` if an upstream ever omits it) instead of the public 45-second policy. So a response carrying ACAO for one Origin can never be reused for another Origin, or for a caller without `Origin`. Cloudflare's Worker Cache API does not key `match()` on `Origin`, so this bypass, not `Vary`, is what enforces the invariant.
- **No-Origin consumers** (CLI, agents, servers) keep the existing behaviour: successful unconditioned `GET` without `Accept` is cached for `CACHE_TTL_SECONDS` under the URL key.
- **Cost.** Browser reads are not edge-cached and each one counts against the per-IP limiter (a preflight counts too). Simple CORS GETs from Gavel Web send no custom headers and so trigger no preflight. Origin-aware edge caching is deliberately out of scope.

Production browser access needs **both** halves. The Node API needs `GAVEL_INDEX_CORS_ORIGINS=https://gavel.0773h.com`, and this Worker needs Origin forwarding plus the Origin cache bypass. Either one alone gives browsers no usable CORS.

## Coordinated deployment (instructions, not authorization)

1. Use reviewed, merged Governance-Indexer `main` (it contains both the Node CORS change and this Worker).
2. Sysadmin builds and pins the Node API image from that SHA (see `docs/DEPLOYMENT.md`, "CORS-only API handoff").
3. Deploy **API only** with `GAVEL_INDEX_CORS_ORIGINS=https://gavel.0773h.com`.
4. Verify loopback CORS on Terra against `http://127.0.0.1:18080` (allowed / denied / preflight / no-Origin).
5. Before deploying the Worker, confirm the active Worker version with an authorised account (`npx wrangler deployments list`) and record it as the Worker rollback target. `PROVENANCE.md` expects `1e582742-5c8a-4f4e-ac0c-1027c421051f`; any mismatch must be reconciled first. Then `npm test`, `npx wrangler deploy --dry-run`, `npx wrangler deploy` from this directory at the reviewed SHA.
   Also confirm there is no Cloudflare cache rule (for example "Cache Everything" with an edge TTL) on the private `ORIGIN_URL` hostname, and no CORS settings on its Access application. The Worker's own upstream fetch goes through the zone cache, which keys by URL. Today it is safe only because the Node API sends `no-store`. Access CORS settings would answer `OPTIONS` before it reaches Node.
6. Run the public-edge checks below.
7. Only then declare Index browser access available to Gavel Web.

**Worker-first is also safe.** If the Worker is deployed before the API has CORS configured, the API returns no ACAO and no `Vary`. Browsers see exactly what they see today: no CORS. `OPTIONS /v1/*` then returns the API's `405` instead of the Worker's `404`. Browser-origin requests lose edge caching. No-Origin caching is unchanged; no-Origin responses only gain `Vary: Origin` and `x-gavel-edge-cache`, and a no-Origin `OPTIONS /v1/*` now reaches the API (405) and counts against the rate limiter. The recommended order above keeps each step independently verifiable.

### Public-edge verification (Sysadmin)

```bash
B=https://index.0773h.com/v1/daos
A=https://gavel.0773h.com
E=https://evil.example
hdr() { grep -iE '^(HTTP|access-control|vary|cache-control|x-gavel-edge-cache)'; }

# Allowed GET: 200, ACAO exactly $A, Vary includes Origin, cache-control no-store, edge BYPASS, no credentials
curl -sS -o /dev/null -D - -H "Origin: $A" "$B" | hdr
# Denied GET: 200, NO access-control-allow-origin, Vary includes Origin, edge BYPASS
curl -sS -o /dev/null -D - -H "Origin: $E" "$B" | hdr
# Allowed preflight: 204, ACAO $A, Allow-Methods "GET, HEAD", Vary "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
curl -sS -o /dev/null -D - -X OPTIONS -H "Origin: $A" -H 'Access-Control-Request-Method: GET' "$B" | hdr
# Forbidden method preflight: 403, no ACAO
curl -sS -o /dev/null -D - -X OPTIONS -H "Origin: $A" -H 'Access-Control-Request-Method: POST' "$B" | hdr
# Denied-origin preflight: 403, no ACAO
curl -sS -o /dev/null -D - -X OPTIONS -H "Origin: $E" -H 'Access-Control-Request-Method: GET' "$B" | hdr
# Non-API OPTIONS still Worker 404
curl -sS -o /dev/null -D - -X OPTIONS -H "Origin: $A" -H 'Access-Control-Request-Method: GET' https://index.0773h.com/health | hdr
# Allowed error response keeps CORS: 404/400 with ACAO $A
curl -sS -o /dev/null -D - -H "Origin: $A" https://index.0773h.com/v1/nope | hdr

# No-Origin consumers: twice -> MISS then HIT (unless already warm), public max-age=45, NO ACAO.
# `-H 'Accept:'` is required: curl sends `Accept: */*` by default, and any Accept bypasses the cache.
curl -sS -o /dev/null -D - -H 'Accept:' "$B" | hdr; curl -sS -o /dev/null -D - -H 'Accept:' "$B" | hdr

# Cache-leak attack: alternate on one URL. `-H 'Accept:'` makes the no-Origin lines really
# fill and hit the shared cache (expect MISS/HIT there), so the Origin lines are tested against a warm entry.
# Expect ACAO only on $A lines, every Origin line BYPASS, no-Origin lines never with ACAO.
for o in "$A" "$E" "$A" "" "$E" "$A" ""; do
  printf '%-26s ' "${o:-<none>}"
  curl -sS -o /dev/null -D - -H 'Accept:' ${o:+-H "Origin: $o"} "$B" \
    | grep -iE '^(access-control-allow-origin|x-gavel-edge-cache):' | tr -d '\r' | tr '\n' ' '; echo
done
```

Failure on any check, especially ACAO on a denied, mismatched or no-Origin line, means stop and roll back the Worker.

### Rollback (independent)

- **Worker:** `npx wrangler rollback <previous-version-id>` (or the dashboard's Deployments → Rollback) to the version recorded in step 5. The Node API needs no change. The old Worker simply drops `Origin` again, so browsers lose CORS while no-Origin consumers are unaffected.
- **Node API:** follow `docs/DEPLOYMENT.md` (restore the retained previous API image and remove `GAVEL_INDEX_CORS_ORIGINS`, API-only recreate). The Worker needs no change: with no ACAO from the origin, the new Worker passes through no CORS and `OPTIONS /v1/*` returns the API's `405`.

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
