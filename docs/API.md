# HTTP API contract

Read-only API; only GET and HEAD are accepted. JSON responses set `cache-control: no-store`. Invalid path/query inputs return 400 `{error:"invalid_request",message}`; missing records return 404 with endpoint-specific error; unexpected internal failures return 500 `{error:"internal_error",message:"Internal server error"}`. Error logs redact runtime values.

- `GET /health` and `/healthz`: process liveness `{ok:true}`; not DB/index readiness.
- `GET /v1/daos`: `{items:[...]}` DAO configuration rows.
- `GET /v1/status`: overall DB status and checkpoints; checkpoint `lastError` is redacted to `sync_failed`/null.
- `GET /v1/daos/{dao}`: DAO config or 404 `dao_not_found`. Supported IDs: `nouns`, `ens`, `railgun-eth`.
- `GET /v1/daos/{dao}/sync-status`: `{dao,sources:[...]}` with redacted `lastError`.
- `GET /v1/daos/{dao}/proposals?limit=25&cursor=...`: page `{items,nextCursor}`; limit is 1–100, default 25. Proposal serialization preserves raw `state`/`sourceState`, derived `effectiveStatus`, tracking/lifecycle fields, content hash, and canonical `identity` (`dao`, `chainId`, lowercase `governorAddress`, decimal `proposalId`).
- `GET /v1/daos/{dao}/proposals/{decimal-id}`: canonical proposal or 404 `proposal_not_found`; identity inconsistencies fail closed.
- `GET /v1/daos/{dao}/voters/{address}/history?limit=25&cursor=...`: paged indexed vote events plus joined canonical proposal data.
- `GET /v1/daos/{dao}/votes?limit=25&cursor=...&voter=...`: paged vote events, optionally voter-filtered.
- `GET /v1/gate/daos/nouns/proposals/{id}` and `/targets/{targetId}`: legacy Gate-specific read views retained for compatibility during decoupling; candidate target has canonical Nouns lifecycle fields.

Cursor values are opaque. API has no authentication, write endpoint, or configured rate limit; place private deployments behind an authenticated private network/proxy. This contract is extracted from Gavel `42edbb49aa13e76be1488f94f6717ca6557447c2`, including post-#68 identity hardening. Gavel CLI/TUI/Bankr/Hermes clients remain outside this repository.

## Optional browser CORS

`GAVEL_INDEX_CORS_ORIGINS` is an API-only, comma-separated allowlist of exact HTTPS origins (for example `https://gavel.0773h.com`). Whitespace around entries is trimmed. Unset or blank preserves the previous behavior. Invalid entries—including wildcard, path, query, fragment, trailing slash, URL credentials, or non-HTTPS URLs—fail startup. Matching is exact and case-sensitive; unlisted origins are never reflected. Only GET and HEAD are permitted; OPTIONS preflight accepts an allowed origin with `Access-Control-Request-Method: GET` or `HEAD` and no custom requested headers, returning 204. Disallowed preflights return 403; requests without Origin retain ordinary behavior. No credentialed CORS or custom allowed headers are enabled. Ordinary responses under configured CORS carry `Vary: Origin` even for denied or absent Origin; preflights also vary by requested method and headers. Existing JSON `Cache-Control: no-store` is unchanged. Any future shared-cache policy must respect these Vary keys (or bypass caching CORS responses); an edge cache that ignores `Vary` cannot safely share variants.
