const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PostgresGovernanceStore } = require("../src/postgres-store");
const { GovernanceSyncWorker } = require("../src/worker");

const databaseUrl = process.env.GOVERNANCE_INDEXER_TEST_DATABASE_URL;
const DISPOSABLE = "governance_nouns_rpc_disposable";
const skip = databaseUrl && new URL(databaseUrl).pathname.slice(1) === DISPOSABLE ? false : `set GOVERNANCE_INDEXER_TEST_DATABASE_URL to the dedicated ${DISPOSABLE} database`;
const governor = "0x0000000000000000000000000000000000000001";
const hash = `0x${"aa".repeat(32)}`;
const contentHash = "bb".repeat(32);
const source = "nouns-subgraph";
function proposal(id, block = 26088824, payload = { id: String(id), description: "RPC" }) {
  return {
    raw: { daoId: "nouns", sourceId: source, sourceRecordKey: `proposal:${id}`, externalId: String(id), chainId: 1,
      contractAddress: governor, transactionHash: null, logIndex: null, blockNumber: String(block), blockHash: hash,
      recordType: "proposal", proposalId: String(id), contentHash, payload,
      sourceKind: block < 26088823 ? "nouns-subgraph" : "nouns-rpc",
      sourceEndpoint: "ethereum-json-rpc", observedHead: String(block) },
    proposal: { daoId: "nouns", proposalId: String(id), contentHash,
      normalized: { id: String(id), title: "RPC title", state: "ACTIVE", effectiveStatus: "ACTIVE", actions: [] }, actions: [] },
  };
}
function vote(block, key) {
  return { raw: { daoId: "nouns", sourceId: source, sourceRecordKey: `vote:${key}`, externalId: key, chainId: 1,
    contractAddress: governor, transactionHash: `0x${Buffer.from(key).toString("hex").padEnd(64, "0")}`, logIndex: 1, blockNumber: String(block),
    blockHash: hash, recordType: "vote", proposalId: "42", payload: { key }, sourceKind: "nouns-rpc",
    sourceEndpoint: "ethereum-json-rpc", observedHead: String(block) },
  vote: { daoId: "nouns", sourceId: source, sourceRecordKey: `vote:${key}`, chainId: 1, contractAddress: governor,
    proposalId: "42", voter: governor, support: "FOR", voteWeight: "1", blockNumber: String(block),
    timestamp: "2024-01-01T00:00:00Z", transactionHash: `0x${Buffer.from(key).toString("hex").padEnd(64, "0")}`, logIndex: 1,
    sourceKind: "nouns-rpc", sourceEndpoint: "ethereum-json-rpc", observedHead: String(block) } };
}

test("migration freezes the legacy checkpoint, RPC replay retains legacy rows and reconciles new rows", { skip }, async () => {
  const store = new PostgresGovernanceStore({ connectionString: databaseUrl, maxConnections: 4 });
  try {
    await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await store.pool.query(await fs.readFile(path.join(__dirname, "../migrations/001_initial.sql"), "utf8"));
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: "nouns", name: "Nouns", chainId: 1, contractAddress: governor, fromBlock: 1 });
      await tx.upsertSource({ daoId: "nouns", id: source, kind: "nouns-subgraph", endpoint: "https://index.example", fromBlock: 1 });
      await tx.setCheckpoint({ daoId: "nouns", sourceId: source, nextBlock: 26088823, finalizedHead: 26088822 });
    });
    await store.migrate({ ensureRoles: false });
    await store.migrate({ ensureRoles: false });
    const marker = await store.getRpcCutoverBlock("nouns", source);
    assert.equal(marker, 26088823);
    await store.transaction(async (tx) => {
      await tx.upsertSource({ daoId: "nouns", id: source, kind: "nouns-rpc", endpoint: "ethereum-json-rpc", fromBlock: 1 });
      await tx.setCheckpoint({ daoId: "nouns", sourceId: source, nextBlock: 26088899, finalizedHead: 26088898 });
    });
    await store.migrate({ ensureRoles: false });
    assert.equal(await store.getRpcCutoverBlock("nouns", source), marker);
    // Legacy subgraph identities are preserved, even if RPC reports no matching event.
    await store.transaction(async (tx) => {
      await tx.ingest(vote(26088820, "legacy"));
      await tx.ingest(proposal(42, 26088820, { id: "42", description: "legacy" }));
      await tx.ingest(vote(26088824, "new"));
      await tx.reconcileRange({ daoId: "nouns", sourceId: source, fromBlock: 26088818, toBlock: 26088825, records: [], cutoverBlock: marker });
      await tx.reconcileProposals({ daoId: "nouns", sourceId: source, records: [], cutoverBlock: marker });
    });
    assert.deepEqual((await store.pool.query("SELECT source_record_key FROM vote_events ORDER BY source_record_key")).rows.map((x) => x.source_record_key), ["vote:legacy"]);
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM raw_governance_records WHERE source_record_key='proposal:42'")).rows[0].n, 1);
    await assert.rejects(store.transaction(async (tx) => { await tx.ingest(proposal(42)); }), /canonical event drift/);
    const raw = (await store.pool.query("SELECT payload,block_number::text AS block FROM raw_governance_records WHERE source_record_key='proposal:42'")).rows[0];
    assert.deepEqual(raw.payload, { id: "42", description: "legacy" });
    assert.equal(raw.block, "26088820");
    assert.equal((await store.getGateProposal("nouns", "42")).proposalId, "42");
    const rpcSource = {
      id: source, config: { source: { kind: "nouns-rpc", endpoint: "ethereum-json-rpc" } },
      rpcUrl: "ethereum-json-rpc", fromBlock: 1, replayBlocks: 100,
      fetchProposals: async () => [],
      fetchRange: async () => [vote(26088820, "rpc-old")],
      normalizeLog: async (row) => row,
    };
    const worker = new GovernanceSyncWorker({ store, sources: { nouns: rpcSource }, batchSize: 1000 });
    await worker.syncDao("nouns", { fromBlock: 26088818, toBlock: 26088824, fullProposalScan: true });
    assert.equal(rpcSource.cutoverBlock, marker);
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM raw_governance_records WHERE source_record_key='vote:rpc-old'")).rows[0].n, 0);
    assert.equal((await store.getCheckpoint("nouns", source)).nextBlock, "26088899");
  } finally { await store.close(); }
});
