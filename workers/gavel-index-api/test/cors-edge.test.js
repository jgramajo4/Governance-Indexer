// Edge CORS/cache behavior of the Worker, exercised against the REAL merged
// Node Index API (src/api.js, Governance-Indexer PR #2) over loopback HTTP.
// The Node API is the single CORS policy owner; these tests prove the Worker
// forwards Origin, passes /v1/ preflight through, preserves the origin's CORS
// headers, and never lets the URL-only shared cache carry an Origin-specific
// response.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import { createWorker } from "../src/index.js";

const require = createRequire(import.meta.url);
const { createReadOnlyApi } = require("../../../src/api.js");

const ALLOWED = "https://gavel.0773h.com";
const DENIED = "https://evil.example";
const PREFLIGHT_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

let server;
let originUrl;
let upstream; // every request the Node API actually received
let worker;
let cache;

const store = {
  async listDaos() { return [{ id: "nouns" }]; },
  async status() { return { checkpoints: [] }; },
  async getDao() { return null; }, // -> 404 dao_not_found
  async listProposals() { throw new Error("db down"); }, // -> 500 internal_error
};

class UrlOnlyCache {
  // Models the production hazard: Cloudflare's shared cache keyed by URL only.
  constructor() { this.values = new Map(); this.reads = 0; this.writes = 0; }
  async match(key) { this.reads += 1; return this.values.get(key.url)?.clone(); }
  async put(key, value) { this.writes += 1; this.values.set(key.url, value.clone()); }
}

const env = () => ({
  ORIGIN_URL: originUrl,
  CACHE_TTL_SECONDS: "45",
  MAX_REQUESTS_PER_MINUTE: "100000",
  MAX_QUERY_LENGTH: "2048",
  MAX_HEADER_BYTES: "16384",
  RATE_LIMITER: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ allowed: true, retryAfterSeconds: 1 }) }) },
});

before(async () => {
  server = createReadOnlyApi({ store, corsOrigins: ALLOWED });
  server.on("request", (req) => upstream.push({ method: req.method, url: req.url, headers: { ...req.headers } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  originUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  upstream = [];
  cache = new UrlOnlyCache();
  worker = createWorker({ fetchImpl: fetch, cache, log: { error() {} } });
});

function call(path, { method = "GET", origin, headers = {} } = {}) {
  return worker.fetch(new Request(`https://index.0773h.com${path}`, {
    method, headers: { ...(origin ? { Origin: origin } : {}), ...headers },
  }), env());
}
const preflight = (path, origin, requestMethod = "GET", extra = {}) => call(path, {
  method: "OPTIONS", origin, headers: { "Access-Control-Request-Method": requestMethod, ...extra },
});

test("allowed Origin is forwarded unchanged and its exact ACAO + Vary are preserved", async () => {
  const response = await call("/v1/daos", { origin: ALLOWED });
  assert.equal(response.status, 200);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].headers.origin, ALLOWED);
  assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("cache-control"), "no-store", "origin cache semantics kept, not public 45s");
  assert.equal(response.headers.get("x-gavel-edge-cache"), "BYPASS");
  assert.deepEqual(await response.json(), { items: [{ id: "nouns" }] });
});

test("denied Origin is forwarded but receives no ACAO from the Worker or origin", async () => {
  const response = await call("/v1/daos", { origin: DENIED });
  assert.equal(response.status, 200);
  assert.equal(upstream[0].headers.origin, DENIED);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("absent Origin stays absent upstream and keeps the existing shared cache", async () => {
  const first = await call("/v1/daos");
  const second = await call("/v1/daos");
  assert.equal(upstream.length, 1, "second no-Origin GET is a cache hit");
  assert.equal(upstream[0].headers.origin, undefined);
  assert.equal(first.headers.get("cache-control"), "public, max-age=45, s-maxage=45");
  assert.equal(first.headers.get("x-gavel-edge-cache"), "MISS");
  assert.equal(second.headers.get("x-gavel-edge-cache"), "HIT");
  assert.equal(first.headers.get("access-control-allow-origin"), null);
  assert.equal(second.headers.get("access-control-allow-origin"), null);
  assert.match(first.headers.get("vary"), /\bOrigin\b/);
  assert.deepEqual(await second.json(), { items: [{ id: "nouns" }] });
});

test("OPTIONS /v1/* reaches the Node API: allowed GET/HEAD preflight -> 204 with exact headers", async () => {
  for (const method of ["GET", "HEAD"]) {
    upstream = [];
    const response = await preflight("/v1/daos", ALLOWED, method);
    assert.equal(response.status, 204);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].method, "OPTIONS");
    assert.equal(upstream[0].headers.origin, ALLOWED);
    assert.equal(upstream[0].headers["access-control-request-method"], method);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD");
    assert.equal(response.headers.get("access-control-allow-headers"), null);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("vary"), PREFLIGHT_VARY);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(cache.reads + cache.writes, 0, "preflight never touches the shared cache");
});

test("disallowed preflights get the Node API's 403 with no permissive CORS", async () => {
  for (const [origin, method, extra] of [
    [DENIED, "GET", {}],
    [ALLOWED, "POST", {}],
    [ALLOWED, "GET", { "Access-Control-Request-Headers": "authorization" }],
  ]) {
    const response = await preflight("/v1/daos", origin, method, extra);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("access-control-allow-methods"), null);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("vary"), PREFLIGHT_VARY);
    assert.deepEqual(await response.json(), { error: "cors_preflight_denied" });
  }
  // Requested headers reach the origin so it, not the Worker, can refuse them.
  assert.equal(upstream.at(-1).headers["access-control-request-headers"], "authorization");
});

test("non-preflight OPTIONS under /v1/ gets the origin's 405; non-API OPTIONS stays a Worker 404", async () => {
  const bare = await call("/v1/daos", { method: "OPTIONS", origin: ALLOWED });
  assert.equal(bare.status, 405);
  assert.equal(bare.headers.get("access-control-allow-origin"), null);
  for (const path of ["/health", "/", "/v2/daos", "/v1"]) {
    upstream = [];
    const response = await preflight(path, ALLOWED);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(upstream.length, 0, `${path} must not reach origin`);
  }
});

test("allowed -> denied -> allowed on one URL never leaks or loses ACAO and never uses the shared cache", async () => {
  // Warm the URL-only cache with a no-Origin entry first: the worst case.
  await call("/v1/daos");
  const writesAfterWarm = cache.writes;
  const readsAfterWarm = cache.reads;
  const sequence = [ALLOWED, DENIED, ALLOWED, DENIED, undefined, ALLOWED, "https://gavel.0773h.com.evil.example", ALLOWED];
  for (const origin of sequence) {
    const response = await call("/v1/daos", { origin });
    const expected = origin === ALLOWED ? ALLOWED : null;
    assert.equal(response.headers.get("access-control-allow-origin"), expected, `origin=${origin}`);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    if (origin) assert.equal(response.headers.get("x-gavel-edge-cache"), "BYPASS");
  }
  const originBearing = sequence.filter(Boolean).length;
  assert.equal(upstream.filter((r) => r.headers.origin).length, originBearing, "every Origin request hit the origin");
  assert.equal(cache.writes, writesAfterWarm, "Origin-bearing responses are never stored");
  assert.equal(cache.reads, readsAfterWarm + 1, "only the single no-Origin request read the cache");
});

test("a denied-origin response cannot poison a later allowed origin (and vice versa)", async () => {
  const denied = await call("/v1/status", { origin: DENIED });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const allowed = await call("/v1/status", { origin: ALLOWED });
  assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED);
  const noOrigin = await call("/v1/status");
  assert.equal(noOrigin.headers.get("access-control-allow-origin"), null, "ACAO never served to no-Origin callers");
  assert.equal(upstream.length, 3);
});

test("HEAD with Origin keeps ACAO/Vary and bypasses cache", async () => {
  const response = await call("/v1/daos", { method: "HEAD", origin: ALLOWED });
  assert.equal(response.status, 200);
  assert.equal(upstream[0].method, "HEAD");
  assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(cache.reads + cache.writes, 0);
});

test("origin error responses (400/404/500) keep the Node API's ACAO and Vary for an allowed Origin", async () => {
  for (const [path, status, error] of [
    ["/v1/daos/not-a-dao", 400, "invalid_request"],
    ["/v1/daos/nouns", 404, "dao_not_found"],
    ["/v1/nope", 404, "not_found"],
    ["/v1/daos/nouns/proposals", 500, "internal_error"],
  ]) {
    const allowed = await call(path, { origin: ALLOWED });
    assert.equal(allowed.status, status, path);
    assert.equal((await allowed.json()).error, error);
    assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED, path);
    assert.equal(allowed.headers.get("vary"), "Origin");
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    const denied = await call(path, { origin: DENIED });
    assert.equal(denied.status, status);
    assert.equal(denied.headers.get("access-control-allow-origin"), null, path);
  }
  assert.equal(cache.writes, 0);
});

test("Accept, conditional and Range headers are still forwarded alongside Origin", async () => {
  await call("/v1/daos", { origin: ALLOWED, headers: {
    Accept: "application/json", "If-None-Match": "\"abc\"", "If-Modified-Since": "Tue, 06 Oct 2026 00:00:00 GMT", Range: "bytes=0-3",
  } });
  const h = upstream[0].headers;
  assert.equal(h.accept, "application/json");
  assert.equal(h["if-none-match"], "\"abc\"");
  assert.equal(h["if-modified-since"], "Tue, 06 Oct 2026 00:00:00 GMT");
  assert.equal(h.range, "bytes=0-3");
  assert.equal(h.origin, ALLOWED);
});

test("non-GET/HEAD/OPTIONS methods and non-/v1/ routes are still rejected before origin", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await call("/v1/daos", { method, origin: ALLOWED });
    assert.equal(response.status, 404, method);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await call("/health", { origin: ALLOWED })).status, 404);
  assert.equal(upstream.length, 0);
});

test("Worker never invents CORS: it adds no ACAO/credentials and never rewrites an exact ACAO", async () => {
  // A misbehaving or unconfigured origin: no CORS headers at all.
  const plain = createWorker({ fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), cache: new UrlOnlyCache(), log: { error() {} } });
  const bare = await plain.fetch(new Request("https://index.0773h.com/v1/daos", { headers: { Origin: ALLOWED } }), env());
  assert.equal(bare.headers.get("access-control-allow-origin"), null);
  assert.equal(bare.headers.get("access-control-allow-credentials"), null);
  assert.equal(bare.headers.get("vary"), "Origin", "Vary: Origin added when origin omitted it");
  assert.equal(bare.headers.get("cache-control"), "no-store", "fail closed when origin omitted Cache-Control");
  const preflightNoCors = await plain.fetch(new Request("https://index.0773h.com/v1/daos", {
    method: "OPTIONS", headers: { Origin: ALLOWED, "Access-Control-Request-Method": "GET" },
  }), env());
  assert.equal(preflightNoCors.headers.get("access-control-allow-origin"), null, "no fabricated preflight success");

  // Origin-provided exact ACAO and multi-token Vary pass through unchanged.
  const exact = createWorker({ fetchImpl: async () => new Response(null, { status: 204, headers: {
    "access-control-allow-origin": ALLOWED, "access-control-allow-methods": "GET, HEAD", vary: PREFLIGHT_VARY, "cache-control": "no-store",
  } }), cache: new UrlOnlyCache(), log: { error() {} } });
  const passed = await exact.fetch(new Request("https://index.0773h.com/v1/daos", {
    method: "OPTIONS", headers: { Origin: ALLOWED, "Access-Control-Request-Method": "GET" },
  }), env());
  assert.equal(passed.headers.get("access-control-allow-origin"), ALLOWED);
  assert.equal(passed.headers.get("vary"), PREFLIGHT_VARY);
  assert.equal(passed.headers.get("access-control-allow-credentials"), null);
});

test("Origin is never synthesized for no-Origin OPTIONS or GET", async () => {
  await call("/v1/daos", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } });
  await call("/v1/status");
  assert.equal(upstream.length, 2);
  for (const r of upstream) assert.equal(r.headers.origin, undefined);
  assert.equal(cache.writes, 1, "only the no-Origin GET is cached; OPTIONS never is");
});
