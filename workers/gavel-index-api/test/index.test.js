import assert from "node:assert/strict";
import test from "node:test";
import { createWorker, RateLimiter } from "../src/index.js";

const env = {
  ORIGIN_URL: "https://private-index.example.internal",
  CF_ACCESS_CLIENT_ID: "worker-access-client-id",
  CF_ACCESS_CLIENT_SECRET: "worker-access-client-secret",
  CACHE_TTL_SECONDS: "45",
  MAX_REQUESTS_PER_MINUTE: "2",
  MAX_QUERY_LENGTH: "64",
  MAX_HEADER_BYTES: "512",
  RATE_LIMITER: { idFromName: (name) => name, get: (id) => ({ fetch: async (_request, init) => Response.json(await limiter.check(id, JSON.parse(init.body))) }) },
};

let limiter;

function request(path, options = {}) {
  return new Request(`https://index.0773h.com${path}`, options);
}

function makeWorker({ fetchImpl, cache } = {}) {
  limiter = new FakeLimiter();
  return createWorker({
    fetchImpl: fetchImpl || (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })),
    cache: cache || new FakeCache(),
    now: () => 1_700_000_000_000,
  });
}

class FakeLimiter {
  constructor() { this.counts = new Map(); }
  async check(ip) {
    const count = (this.counts.get(ip) || 0) + 1;
    this.counts.set(ip, count);
    return { allowed: count <= 2, retryAfterSeconds: 60 };
  }
}

class FakeCache {
  constructor() { this.values = new Map(); }
  async match(key) { return this.values.get(key.url)?.clone(); }
  async put(key, value) { this.values.set(key.url, value.clone()); }
}

test("allows only GET and HEAD under /v1/", async () => {
  const worker = makeWorker();
  assert.equal((await worker.fetch(request("/v1/daos"), env)).status, 200);
  assert.equal((await worker.fetch(request("/v1/daos", { method: "HEAD" }), env)).status, 200);
  assert.equal((await worker.fetch(request("/health"), env)).status, 404);
  assert.equal((await worker.fetch(request("/v1/daos", { method: "POST" }), env)).status, 404);
});

test("preserves the full query string in the origin and cache key", async () => {
  const seen = [];
  const worker = makeWorker({ fetchImpl: async (input) => {
    seen.push(new URL(input.url));
    return new Response("page", { status: 200 });
  } });
  await worker.fetch(request("/v1/daos/ens/proposals?limit=10&cursor=opaque"), env);
  await worker.fetch(request("/v1/daos/ens/proposals?limit=20&cursor=other"), env);
  assert.deepEqual(seen.map((url) => `${url.pathname}${url.search}`), [
    "/v1/daos/ens/proposals?limit=10&cursor=opaque",
    "/v1/daos/ens/proposals?limit=20&cursor=other",
  ]);
});

test("adds only Worker-held Access service credentials to the origin request", async () => {
  let headers;
  const worker = makeWorker({ fetchImpl: async (input) => {
    headers = input.headers;
    return new Response("ok", { status: 200 });
  } });
  await worker.fetch(request("/v1/daos", { headers: {
    "CF-Access-Client-Id": "attacker-client-id",
    "CF-Access-Client-Secret": "attacker-client-secret",
    Authorization: "Bearer attacker-token",
  } }), env);
  assert.equal(headers.get("cf-access-client-id"), "worker-access-client-id");
  assert.equal(headers.get("cf-access-client-secret"), "worker-access-client-secret");
  assert.equal(headers.get("authorization"), null);
});

test("caches only successful GET responses and adds a public cache policy", async () => {
  let calls = 0;
  const worker = makeWorker({ fetchImpl: async () => {
    calls += 1;
    return new Response("cached", { status: 200, headers: { "x-internal-host": "private-index.example.internal" } });
  } });
  const first = await worker.fetch(request("/v1/status"), env);
  const second = await worker.fetch(request("/v1/status"), env);
  assert.equal(await first.text(), "cached");
  assert.equal(await second.text(), "cached");
  assert.equal(calls, 1);
  assert.equal(first.headers.get("cache-control"), "public, max-age=45, s-maxage=45");
  assert.equal(first.headers.get("x-internal-host"), null);
});

test("strips Access session cookies from origin responses", async () => {
  const worker = makeWorker({ fetchImpl: async () => new Response("{\"ok\":true}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "CF_Authorization=secret-jwt; Path=/; HttpOnly",
      "cf-access-jwt-assertion": "secret-jwt",
    },
  }) });
  const response = await worker.fetch(request("/v1/daos"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cf-access-jwt-assertion"), null);
});

test("does not cache range, conditional, or Accept-variant requests", async () => {
  let calls = 0;
  const worker = makeWorker({ fetchImpl: async (input) => {
    calls += 1;
    return new Response(input.headers.get("accept") || "partial", { status: 200, headers: { "vary": "accept" } });
  } });
  const rangeHeaders = { Range: "bytes=0-6" };
  assert.equal((await worker.fetch(request("/v1/daos", { headers: rangeHeaders }), env)).status, 200);
  assert.equal((await worker.fetch(request("/v1/daos", { headers: rangeHeaders }), env)).status, 200);
  const json = await worker.fetch(request("/v1/daos", { headers: { Accept: "application/json", "CF-Connecting-IP": "203.0.113.8" } }), env);
  const html = await worker.fetch(request("/v1/daos", { headers: { Accept: "text/html", "CF-Connecting-IP": "203.0.113.9" } }), env);
  assert.equal(await json.text(), "application/json");
  assert.equal(await html.text(), "text/html");
  assert.equal(calls, 4);
});

test("converts upstream redirects into a generic error without leaking Location", async () => {
  const worker = makeWorker({ fetchImpl: async () => new Response(null, {
    status: 302,
    headers: { location: "https://private-index.example.internal/login" },
  }) });
  const response = await worker.fetch(request("/v1/daos"), env);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
});

test("returns 429 with Retry-After after the per-IP limit", async () => {
  const worker = makeWorker();
  const headers = { "CF-Connecting-IP": "203.0.113.7" };
  assert.equal((await worker.fetch(request("/v1/daos", { headers }), env)).status, 200);
  assert.equal((await worker.fetch(request("/v1/daos", { headers }), env)).status, 200);
  const blocked = await worker.fetch(request("/v1/daos", { headers }), env);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.deepEqual(await blocked.json(), { error: "rate_limited" });
});

test("rejects oversized query strings and headers without calling the origin", async () => {
  let calls = 0;
  const worker = makeWorker({ fetchImpl: async () => { calls += 1; return new Response("nope"); } });
  assert.equal((await worker.fetch(request(`/v1/daos?x=${"a".repeat(65)}`), env)).status, 414);
  assert.equal((await worker.fetch(request("/v1/daos", { headers: { "x-large": "a".repeat(600) } }), env)).status, 431);
  assert.equal(calls, 0);
});

test("returns generic errors and does not leak origin details", async () => {
  const worker = makeWorker({ fetchImpl: async () => { throw new Error("dial tcp private-index.example.internal:8080 refused"); } });
  const response = await worker.fetch(request("/v1/daos"), env);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
  assert.equal((await response.text().catch(() => "")), "");
});

test("RateLimiter resets an IP counter after its one-minute window", async () => {
  const storage = new FakeStorage();
  const object = new RateLimiter({ storage });
  const check = async (now) => (await (await object.fetch(new Request("https://rate-limiter/check", {
    method: "POST", body: JSON.stringify({ limit: 1, now }), headers: { "content-type": "application/json" },
  }))).json()).allowed;
  assert.equal(await check(1_000), true);
  assert.equal(await check(1_001), false);
  assert.equal(await check(61_001), true);
});

class FakeStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
}
