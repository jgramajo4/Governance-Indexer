// Integration tests against a real PostgreSQL server. These cover what a
// query() stub cannot: that the migration actually executes, that the canonical
// uniqueness constraints hold, that ingestion is idempotent, and that the API
// role genuinely cannot write.
//
// Set GAVEL_TEST_DATABASE_URL to a database the test may create and drop
// objects in. Without it the suite skips rather than silently passing.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { candidateTargetId } = require("../src/domain/nouns-candidate");

const { PostgresGovernanceStore, PostgresTransaction } = require("../src/postgres-store");
const { ensureRoles } = require("../src/roles");

const CLI = path.join(__dirname, "..", "bin", "gavel-indexer.js");
const INDEXER_PASSWORD = "indexer-test-only";
const API_PASSWORD = "api-test-only";

function runCli(args, extra = {}) {
  const env = { ...process.env, DATABASE_URL: ADMIN_URL, ...extra };
  for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) delete env[key];
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines.at(-1)); } catch { /* reported through stdout below */ }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

async function dropApplicationRoles(store) {
  for (const role of ["gavel_api", "gavel_indexer"]) {
    try {
      await store.pool.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${role}'; END IF; END $$;`);
      await store.pool.query(`DROP ROLE IF EXISTS ${role}`);
    } catch { /* checked by the caller */ }
  }
  return (await store.pool.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('gavel_indexer','gavel_api')",
  )).rows.map((row) => row.rolname);
}

async function withApplicationRoles(store) {
  await ensureRoles(store.pool, {
    env: { GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD, GAVEL_API_DB_PASSWORD: API_PASSWORD },
  });
  for (const [role, password] of [["gavel_indexer", INDEXER_PASSWORD], ["gavel_api", API_PASSWORD]]) {
    const statement = (await store.pool.query(
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS stmt", [role, password],
    )).rows[0].stmt;
    await store.pool.query(statement);
  }
}

async function dropProbeRole(store, role) {
  await store.pool.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${role}'; END IF; END $$;`);
  await store.pool.query(`DROP ROLE IF EXISTS ${role}`);
}

function roleUrl(role, password) {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = password;
  return url.toString();
}

const ADMIN_URL = process.env.GOVERNANCE_INDEXER_TEST_DATABASE_URL || process.env.GAVEL_TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : "set GAVEL_TEST_DATABASE_URL to run PostgreSQL integration tests";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const GOVERNOR = "0x323A76393544d5ecca80cd6ef2A560C6a395b7E3";
const TX = `0x${"11".repeat(32)}`;
const TX2 = `0x${"22".repeat(32)}`;

function voteRow(overrides = {}) {
  return {
    daoId: "ens", chainId: 1, contractAddress: GOVERNOR, proposalId: "1", voter: ADDRESS,
    support: "FOR", reason: null, voteWeight: "100", blockNumber: "10",
    timestamp: new Date(1_700_000_000_000).toISOString(), transactionHash: TX, logIndex: 0,
    sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20",
    ...overrides,
  };
}

function record(overrides = {}) {
  const { vote, ...rest } = overrides;
  return {
    raw: {
      daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: GOVERNOR,
      transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: null, recordType: "vote",
      proposalId: "1", payload: { topics: [], data: "0x" }, sourceKind: "ens-governor-logs",
      sourceEndpoint: "https://rpc.example", observedHead: "20", ...rest,
    },
    vote: vote === null ? undefined : voteRow(vote),
  };
}

async function freshStore() {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await store.migrate();
  await store.transaction(async (tx) => {
    await tx.upsertDao({ id: "ens", name: "ENS", chainId: 1, contractAddress: GOVERNOR, currentGovernor: GOVERNOR, fromBlock: 5 });
    await tx.upsertSource({ daoId: "ens", id: "governor-logs", kind: "ens-governor-logs", endpoint: "https://rpc.example/key", publicEndpoint: "https://rpc.example", fromBlock: 5 });
  });
  return store;
}

test("migration applies against a real PostgreSQL server", { skip }, async () => {
  const store = await freshStore();
  try {
    const tables = (await store.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    assert.deepEqual(tables, [
      "candidate_snapshots", "daos", "delegation_events", "governance_sources", "governance_targets", "nouns_proposal_refreshes", "proposal_actions",
      "proposals", "raw_governance_records", "schema_migrations", "sync_checkpoints", "vote_events",
    ]);
    const applied = (await store.pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((row) => row.version);
    assert.ok(applied.includes("001_initial"));
    assert.ok(applied.includes("003_proposal_lifecycle"));
    assert.ok(applied.includes("004_nouns_candidates"));
    assert.ok(applied.includes("005_nouns_rpc_cutover"));
    assert.ok(applied.includes("006_nouns_candidate_cache"));
    assert.ok(applied.includes("007_nouns_proposal_refresh"));
  } finally { await store.close(); }
});

test("the lifecycle migration backfills tracking state from the already-derived outcome", { skip }, async () => {
  const store = await freshStore();
  try {
    const rows = [
      ["992", "ACTIVE", "DEFEATED", "FINAL"],
      ["994", "CANCELLED", "CANCELLED", "FINAL"],
      ["995", "ACTIVE", "DEFEATED", "FINAL"],
      ["996", "PENDING", "PENDING", "HOT"],
      ["997", "ACTIVE", "SUCCEEDED", "WARM"],
    ];
    for (const [id, status, outcome] of rows) {
      await store.pool.query(`
        INSERT INTO proposals(dao_id,proposal_id,content_hash,proposal_status,outcome,normalized,lifecycle_reason)
        VALUES('ens',$1,$2,$3,$4,'{}'::jsonb,NULL)
      `, [id, "a".repeat(64), status, outcome]);
    }
    await store.pool.query(await require("node:fs/promises").readFile(
      require("node:path").join(__dirname, "..", "migrations", "003_proposal_lifecycle.sql"), "utf8",
    ));
    const migrated = (await store.pool.query(
      "SELECT proposal_id::text AS id,proposal_status,effective_status,tracking_state FROM proposals WHERE dao_id='ens' ORDER BY proposal_id",
    )).rows;
    assert.deepEqual(
      migrated.map((row) => [row.id, row.proposal_status, row.effective_status, row.tracking_state]),
      rows,
      "the derived verdict decides tracking state; the raw upstream value is left untouched",
    );
  } finally { await store.close(); }
});

test("canonical event identity rejects a duplicate transaction hash and log index", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => { await tx.insertVote(voteRow()); });
    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.client.query(`
          INSERT INTO vote_events(dao_id,chain_id,contract_address,proposal_id,voter,support,vote_weight,
            block_number,block_time,transaction_hash,log_index,source_kind,source_endpoint,source_public_endpoint,observed_head)
          VALUES('ens',1,$1,'1',$2,'AGAINST','5',10,now(),$3,0,'k','https://e','https://e',20)
        `, [GOVERNOR, OTHER, TX]);
      }),
      /duplicate key value violates unique constraint/,
    );
  } finally { await store.close(); }
});

test("re-ingesting the same batch is idempotent and repairs a dropped vote", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => { assert.equal(await tx.ingest(record()), true); });
    await store.transaction(async (tx) => { assert.equal(await tx.ingest(record()), false); });
    const counts = async () => ({
      raw: Number((await store.pool.query("SELECT count(*) c FROM raw_governance_records")).rows[0].c),
      votes: Number((await store.pool.query("SELECT count(*) c FROM vote_events")).rows[0].c),
    });
    assert.deepEqual(await counts(), { raw: 1, votes: 1 });
    await store.pool.query("DELETE FROM vote_events");
    await store.transaction(async (tx) => { await tx.ingest(record()); });
    assert.deepEqual(await counts(), { raw: 1, votes: 1 });
  } finally { await store.close(); }
});

test("proposal refresh persists coherent Gate provenance against real PostgreSQL", { skip }, async () => {
  const store = await freshStore();
  const contentHash = "a".repeat(64);
  const firstHash = `0x${"33".repeat(32)}`;
  const refreshedHash = `0x${"44".repeat(32)}`;
  const makeRecord = (blockNumber, blockHash, { sourceId = "nouns-subgraph", sourceRecordKey = "proposal:42", effectiveStatus = "ACTIVE" } = {}) => ({
    raw: {
      daoId: "nouns", sourceId, sourceRecordKey, externalId: "42",
      chainId: 1, contractAddress: GOVERNOR, transactionHash: null, logIndex: null, blockNumber,
      blockHash, recordType: "proposal", proposalId: "42", contentHash, payload: { id: "42" },
      sourceKind: "nouns-subgraph", sourceEndpoint: "https://index.example", observedHead: blockNumber,
    },
    proposal: {
      daoId: "nouns", proposalId: "42", contentHash,
      normalized: { id: "42", title: "Canonical title", proposer: ADDRESS,
        state: effectiveStatus, effectiveStatus, actions: [] },
      actions: [{ index: 0, target: ADDRESS, valueWei: "0", signature: "", calldata: "0x" }],
    },
  });
  try {
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: "nouns", name: "Nouns", chainId: 1, contractAddress: GOVERNOR, currentGovernor: GOVERNOR, fromBlock: 1 });
      await tx.upsertSource({ daoId: "nouns", id: "nouns-subgraph", kind: "nouns-subgraph", endpoint: "https://index.example", fromBlock: 1 });
      assert.equal(await tx.ingest(makeRecord("100", firstHash)), true);
      assert.equal(await tx.ingest(makeRecord("105", refreshedHash)), false);
      assert.equal(await tx.ingest(makeRecord("101", `0x${"55".repeat(32)}`, { effectiveStatus: "DEFEATED" })), false);
      await tx.upsertSource({ daoId: "nouns", id: "unrelated", kind: "nouns-subgraph", endpoint: "https://index.example", fromBlock: 1 });
      assert.equal(await tx.ingest(makeRecord("999", `0x${"66".repeat(32)}`, {
        sourceId: "unrelated", sourceRecordKey: "proposal:unrelated",
      })), true);
    });
    const persisted = (await store.pool.query(`
      SELECT block_number::text AS "blockNumber",observed_head::text AS "observedHead",block_hash AS "blockHash"
      FROM raw_governance_records WHERE dao_id='nouns' AND source_record_key='proposal:42'
    `)).rows[0];
    assert.deepEqual(persisted, { blockNumber: "105", observedHead: "105", blockHash: refreshedHash });
    const gate = await store.getGateProposal("nouns", "42");
    assert.deepEqual(gate, {
      chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "42",
      title: "Canonical title", proposer: ADDRESS, refreshedAt: gate.refreshedAt,
      sourceBlock: "105", sourceBlockHash: refreshedHash, effectiveStatus: "ACTIVE",
      contentHash: `0x${contentHash}`,
      actions: [{ actionIndex: 0, target: ADDRESS, valueWei: "0", signature: "", calldata: "0x" }],
    });
  } finally { await store.close(); }
});

test("concurrent first proposal ingestion cannot roll normalized state behind raw provenance", { skip }, async () => {
  const store = await freshStore();
  const contentHash = "b".repeat(64);
  const makeRecord = (blockNumber, effectiveStatus) => ({
    raw: {
      daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:77", externalId: "77",
      chainId: 1, contractAddress: GOVERNOR, transactionHash: null, logIndex: null, blockNumber,
      blockHash: `0x${String(blockNumber).padStart(64, "0")}`, recordType: "proposal", proposalId: "77",
      contentHash, payload: { id: "77" }, sourceKind: "nouns-subgraph",
      sourceEndpoint: "https://index.example", observedHead: blockNumber,
    },
    proposal: {
      daoId: "nouns", proposalId: "77", contentHash,
      normalized: { id: "77", state: effectiveStatus, effectiveStatus, actions: [] }, actions: [],
    },
  });
  const newerClient = await store.pool.connect();
  const staleClient = await store.pool.connect();
  try {
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: "nouns", name: "Nouns", chainId: 1, contractAddress: GOVERNOR, currentGovernor: GOVERNOR, fromBlock: 1 });
      await tx.upsertSource({ daoId: "nouns", id: "nouns-subgraph", kind: "nouns-subgraph", endpoint: "https://index.example", fromBlock: 1 });
    });
    await newerClient.query("BEGIN");
    await staleClient.query("BEGIN");
    const newer = new PostgresTransaction(newerClient);
    const stale = new PostgresTransaction(staleClient);
    assert.equal(await newer.ingest(makeRecord("200", "ACTIVE")), true);
    const staleWrite = stale.ingest(makeRecord("100", "DEFEATED"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await newerClient.query("COMMIT");
    assert.equal(await staleWrite, false);
    await staleClient.query("COMMIT");
    const raw = (await store.pool.query("SELECT block_number::text AS block FROM raw_governance_records WHERE dao_id='nouns' AND source_record_key='proposal:77'")).rows[0];
    const proposal = (await store.pool.query("SELECT effective_status AS status FROM proposals WHERE dao_id='nouns' AND proposal_id=77")).rows[0];
    assert.deepEqual({ raw, proposal }, { raw: { block: "200" }, proposal: { status: "ACTIVE" } });
  } finally {
    try { await newerClient.query("ROLLBACK"); } catch {}
    try { await staleClient.query("ROLLBACK"); } catch {}
    newerClient.release();
    staleClient.release();
    await store.close();
  }
});

test("candidate refresh persists exact target identity, lifecycle, content, and provenance", { skip }, async () => {
  const store = await freshStore();
  const proposer = "0x1111111111111111111111111111111111111111";
  const targetId = candidateTargetId(proposer, "slug");
  const contentHash = "bb".repeat(32);
  const makeRecord = (blockNumber, eligibility) => ({
    raw: {
      daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: targetId, externalId: "display-id",
      chainId: 1, contractAddress: ADDRESS,
      transactionHash: `0x${String(blockNumber).padStart(64, "1")}`, logIndex: 0, blockNumber,
      blockHash: `0x${String(blockNumber).padStart(64, "0")}`, recordType: "proposal_candidate",
      proposalId: null, contentHash, payload: { id: "display-id" }, sourceKind: "nouns-subgraph",
      sourceEndpoint: "https://index.example", observedHead: blockNumber,
    },
    target: {
      dao: "nouns", targetId, kind: "candidate", proposer, slug: "slug", title: "Candidate title",
      description: "# Candidate title", nativeState: eligibility === "CLOSED" ? "CANCELED" : "ACTIVE",
      eligibility, mappingVersion: "nouns-candidate-lifecycle/1", contentHash: `0x${contentHash}`,
      actions: [{ actionIndex: 0, target: ADDRESS, valueWei: "0", signature: "", calldata: "0x" }],
      latestVersion: { id: `v${blockNumber}`, createdBlock: blockNumber, createdTimestamp: "1700000000", updateMessage: "" },
    },
  });
  try {
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: "nouns", name: "Nouns", chainId: 1, contractAddress: GOVERNOR, currentGovernor: GOVERNOR, fromBlock: 1 });
      await tx.upsertSource({ daoId: "nouns", id: "nouns-subgraph", kind: "nouns-subgraph", endpoint: "https://index.example", fromBlock: 1 });
      assert.equal(await tx.ingest(makeRecord("200", "PRE_VOTE")), true);
    });
    await assert.rejects(store.transaction(async (tx) => {
      const rewritten = makeRecord("200", "PRE_VOTE");
      rewritten.raw.contentHash = "cc".repeat(32);
      rewritten.raw.payload = { id: "tampered" };
      rewritten.target.contentHash = `0x${"cc".repeat(32)}`;
      rewritten.target.title = "Tampered title";
      await tx.ingest(rewritten);
    }), /canonical candidate drift/);
    await store.transaction(async (tx) => {
      assert.equal(await tx.ingest(makeRecord("201", "CLOSED")), false);
      assert.equal(await tx.ingest(makeRecord("199", "PRE_VOTE")), false);
    });
    const target = await store.getGateTarget("nouns", targetId);
    assert.deepEqual(target, {
      dao: "nouns", targetId, kind: "candidate", proposer, slug: "slug", title: "Candidate title",
      description: "# Candidate title", nativeState: "CANCELED", eligibility: "CLOSED",
      mappingVersion: "nouns-candidate-lifecycle/1", contentHash: `0x${contentHash}`,
      actions: [{ actionIndex: 0, target: ADDRESS, valueWei: "0", signature: "", calldata: "0x" }],
      latestVersion: { id: "v201", createdBlock: "201", createdTimestamp: "1700000000", updateMessage: "" },
      refreshedAt: target.refreshedAt, sourceBlock: "201", sourceBlockHash: `0x${"201".padStart(64, "0")}`,
    });
    assert.deepEqual((await store.pool.query(`SELECT transaction_hash AS tx,log_index AS idx
      FROM raw_governance_records WHERE dao_id='nouns' AND source_record_key=$1`, [targetId])).rows[0],
      { tx: `0x${"201".padStart(64, "1")}`, idx: 0 });
    await store.transaction((tx) => tx.reconcileCandidates({ daoId: "nouns", sourceId: "nouns-subgraph", records: [] }));
    assert.equal(await store.getGateTarget("nouns", targetId), null);
  } finally { await store.close(); }
});

test("a failed batch leaves the checkpoint un-advanced", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => {
      await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 100, finalizedHead: 100, lastError: null });
    });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.ingest(record());
      await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 200, finalizedHead: 200, lastError: null });
      throw new Error("batch blew up after writing");
    }), /batch blew up/);
    const checkpoint = await store.getCheckpoint("ens", "governor-logs");
    assert.equal(checkpoint.nextBlock, "100", "checkpoint must not advance past uncommitted data");
    assert.equal(Number((await store.pool.query("SELECT count(*) c FROM raw_governance_records")).rows[0].c), 0);
  } finally { await store.close(); }
});
