const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { createReadOnlyApi } = require("../src/api");

const GAVEL = "https://gavel.0773h.com";
const OTHER = "https://other.example";
const DENIED = "https://denied.example";

async function withServer(corsOrigins, run) {
  const store = { async listDaos() { return [{ id: "nouns" }]; } };
  const server = createReadOnlyApi({ store, corsOrigins: corsOrigins ?? "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/daos`;
    await run((origin, options = {}) => fetch(url, {
      ...options, headers: { ...(origin ? { Origin: origin } : {}), ...options.headers },
    }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("unset and empty configuration keep ordinary GET/OPTIONS behavior", async () => {
  for (const config of [undefined, "", "   "]) {
    await withServer(config, async (request) => {
      const get = await request(GAVEL);
      assert.equal(get.status, 200);
      assert.deepEqual(await get.json(), { items: [{ id: "nouns" }] });
      assert.equal(get.headers.get("access-control-allow-origin"), null);
      assert.equal(get.headers.get("vary"), null);
      assert.equal((await request(GAVEL, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } })).status, 405);
    });
  }
});

test("allowed origins match exactly and carry Vary even on denied and absent Origin responses", async () => {
  await withServer(` ${GAVEL} , ${OTHER} `, async (request) => {
    for (const origin of [GAVEL, OTHER, DENIED, `${GAVEL}/`, "https://GAVEL.0773h.com", undefined]) {
      const response = await request(origin);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), [GAVEL, OTHER].includes(origin) ? origin : null);
      assert.equal(response.headers.get("vary"), "Origin");
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { items: [{ id: "nouns" }] });
    }
  });
});

test("allowed → denied → allowed and denied → allowed never reuse the wrong ACAO", async () => {
  await withServer(GAVEL, async (request) => {
    for (const origin of [GAVEL, DENIED, GAVEL, DENIED, GAVEL]) {
      const response = await request(origin);
      assert.equal(response.headers.get("access-control-allow-origin"), origin === GAVEL ? GAVEL : null);
      assert.equal(response.headers.get("vary"), "Origin");
    }
  });
});

test("preflight permits GET/HEAD only for allowed origins and no custom headers", async () => {
  await withServer(GAVEL, async (request) => {
    const preflight = (origin, method, headers = {}) => request(origin, {
      method: "OPTIONS", headers: { "Access-Control-Request-Method": method, ...headers },
    });
    for (const method of ["GET", "HEAD"]) {
      const response = await preflight(GAVEL, method);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), GAVEL);
      assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD");
      assert.equal(response.headers.get("access-control-allow-headers"), null);
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
      assert.equal(response.headers.get("vary"), "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    }
    for (const [origin, method, headers] of [
      [DENIED, "GET", {}], [GAVEL, "POST", {}], [GAVEL, "GET", { "Access-Control-Request-Headers": "Authorization" }],
    ]) {
      const response = await preflight(origin, method, headers);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("vary"), "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    }
    const nonPreflight = await request(GAVEL, { method: "OPTIONS" });
    assert.equal(nonPreflight.status, 405);
    assert.equal(nonPreflight.headers.get("access-control-allow-origin"), null);
    assert.equal(nonPreflight.headers.get("vary"), "Origin");
    const noOrigin = await preflight(undefined, "GET");
    assert.equal(noOrigin.status, 405);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal(noOrigin.headers.get("vary"), "Origin");
  });
});

test("invalid origin configurations fail before the HTTP server starts", () => {
  for (const config of ["*", "http://gavel.0773h.com", `${GAVEL}/`, `${GAVEL}/path`, `${GAVEL}?x=1`, `${GAVEL}#frag`,
    "not a url", "https://", "https://user:pass@gavel.0773h.com", `${GAVEL},`, `${GAVEL},*`]) {
    assert.throws(() => createReadOnlyApi({ store: {}, corsOrigins: config }), /GAVEL_INDEX_CORS_ORIGINS/);
  }
});

test("serve rejects malformed GAVEL_INDEX_CORS_ORIGINS at startup without binding", () => {
  const result = spawnSync(process.execPath, ["bin/gavel-indexer.js", "serve"], {
    cwd: require("node:path").resolve(__dirname, ".."),
    env: { ...process.env, GAVEL_INDEX_CORS_ORIGINS: "*", API_PORT: "18081" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GAVEL_INDEX_CORS_ORIGINS/);
  assert.doesNotMatch(result.stderr, /api_listening/);
});
