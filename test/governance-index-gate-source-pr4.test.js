const assert = require("node:assert/strict");
const test = require("node:test");

const { PostgresGovernanceStore, PostgresTransaction } = require("../src/postgres-store");
const { NounsSubgraphSource } = require("../src/nouns-source");

const WALLET = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

test("Nouns proposal snapshot provenance is the hash of the pinned block that produced it", async () => {
  const proposal = {
    id: "42", title: "Canonical", description: "body", status: "ACTIVE",
    proposer: { id: WALLET }, targets: [], values: [], signatures: [], calldatas: [],
    createdTimestamp: "1700000000", createdBlock: "100", startBlock: "101", endBlock: "200",
    quorumVotes: "1", forVotes: "0", againstVotes: "0", abstainVotes: "0",
  };
  const requests = [];
  const source = new NounsSubgraphSource({ finalityDepth: 5, fetch: async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    requests.push({ query, variables });
    if (query.includes("PinnedSnapshot")) throw new Error("snapshot provenance must not use a separate request");
    if (!query.includes("proposals(")) return { ok: true, async json() { return { data: { _meta: { block: { number: 205, hash: `0x${"ef".repeat(32)}` } } } }; } };
    return { ok: true, async json() { return { data: {
      _meta: { block: { number: 200, hash: BLOCK_HASH } },
      proposals: variables.after === "" ? [proposal] : [],
    } }; } };
  } });

  const head = await source.head();
  const [record] = await source.fetchProposals(90, head, head, { full: true });
  assert.equal(head, 200);
  assert.equal(record.raw.blockNumber, "200");
  assert.equal(record.raw.blockHash, BLOCK_HASH);
  assert.equal(record.raw.observedHead, "200");
  assert.equal(record.raw.payload.createdBlock, "100");
  assert.equal(requests.filter(({ query }) => query.includes("proposals(")).length, 1);
  assert.match(requests.at(-1).query, /_meta\(block:\{number:\$snapshot\}\)\{block\{number hash\}\}/);
});

test("Nouns proposal pagination fails closed when the pinned block hash changes", async () => {
  const proposal = {
    id: "42", title: "Canonical", description: "body", status: "ACTIVE",
    proposer: { id: WALLET }, targets: [], values: [], signatures: [], calldatas: [],
    createdTimestamp: "1700000000", createdBlock: "100", startBlock: "101", endBlock: "200",
    quorumVotes: "1", forVotes: "0", againstVotes: "0", abstainVotes: "0",
  };
  let page = 0;
  const source = new NounsSubgraphSource({ pageSize: 1, fetch: async () => {
    page += 1;
    return { ok: true, async json() { return { data: {
      _meta: { block: { number: 200, hash: page === 1 ? BLOCK_HASH : `0x${"ef".repeat(32)}` } },
      proposals: page === 1 ? [proposal] : [],
    } }; } };
  } });

  await assert.rejects(
    source.fetchProposals(90, 200, 200, { full: true }),
    /snapshot hash changed during pagination/,
  );
});

test("Nouns incremental proposal discovery fails closed on mismatched snapshot metadata", async () => {
  const source = new NounsSubgraphSource({ fetch: async () => ({
    ok: true,
    async json() {
      return { data: { _meta: { block: { number: 199, hash: BLOCK_HASH } }, proposals: [] } };
    },
  }) });

  await assert.rejects(
    source.fetchProposals(90, 200, 200),
    /snapshot metadata missing or mismatched/,
  );
});

test("Nouns proposal pages reject missing block numbers even at snapshot zero", async () => {
  const source = new NounsSubgraphSource({ fetch: async () => ({
    ok: true,
    async json() {
      return { data: { _meta: { block: { number: null, hash: BLOCK_HASH } }, proposals: [] } };
    },
  }) });

  await assert.rejects(
    source.fetchProposals(0, 0, 0, { full: true }),
    /snapshot metadata missing or mismatched/,
  );
});

test("Nouns proposal refresh fails closed when its hash differs from discovery", async () => {
  const source = new NounsSubgraphSource({ fetch: async (_url, init) => {
    const { query } = JSON.parse(init.body);
    assert.match(query, /_meta\(block:\{number:\$snapshot\}\)\{block\{number hash\}\}/);
    const hash = query.includes("RefreshProposals") ? `0x${"ef".repeat(32)}` : BLOCK_HASH;
    return { ok: true, async json() { return { data: {
      _meta: { block: { number: 200, hash } },
      proposals: [],
    } }; } };
  } });

  await assert.rejects(
    source.fetchProposals(90, 200, 200, { refreshProposals: [{ proposalId: "42" }] }),
    /snapshot hash changed during pagination/,
  );
});

test("Postgres proposal refresh replaces only the snapshot provenance for identical canonical material", async () => {
  const raw = {
    daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:42", externalId: "42",
    chainId: 1, contractAddress: WALLET, transactionHash: null, logIndex: null, blockNumber: "200",
    blockHash: BLOCK_HASH, recordType: "proposal", proposalId: "42", contentHash: HASH.slice(2),
    payload: { id: "42" }, sourceKind: "nouns-subgraph", sourceEndpoint: "https://example.test",
    observedHead: "200",
  };
  const calls = [];
  const tx = new PostgresTransaction({ async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (String(sql).includes("SELECT block_number")) return { rows: [{
      blockNumber: "190", blockHash: `0x${"ef".repeat(32)}`, recordType: "proposal",
      proposalId: "42", contentHash: HASH.slice(2), payload: { id: "42" },
    }] };
    return { rowCount: 1, rows: [] };
  } });

  await tx.ingest({ raw });
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(calls[1].sql, /SELECT block_number/);
  assert.match(calls[2].sql, /UPDATE raw_governance_records/);
  assert.match(calls[2].sql, /SET block_number=\$4,block_hash=\$5,observed_head=\$6,ingested_at=now\(\)/);
  assert.deepEqual(calls[2].values.slice(-3), ["200", BLOCK_HASH, "200"]);
});

test("Postgres full proposal reconciliation permits a newer canonical snapshot of identical material", async () => {
  const material = {
    daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:42", chainId: 1,
    contractAddress: WALLET, transactionHash: null, logIndex: null, recordType: "proposal",
    proposalId: "42", contentHash: HASH.slice(2), payload: { id: "42" },
  };
  const tx = new PostgresTransaction({ async query() { return { rows: [{
    ...material, blockNumber: "190", blockHash: `0x${"ef".repeat(32)}`,
  }] }; } });
  await tx.reconcileProposals({
    daoId: "nouns", sourceId: "nouns-subgraph",
    records: [{ raw: { ...material, blockNumber: "200", blockHash: BLOCK_HASH } }],
  });
});

test("Postgres governance store exposes Gate health and configured canonical power reads", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    return { rows: [{ healthy: true, refreshedAt: new Date("2026-09-14T00:00:00.000Z"), lastError: null }] };
  } };
  const store = new PostgresGovernanceStore({ pool, votingPowerReader: async ({ dao, wallet }) => {
    assert.deepEqual({ dao, wallet }, { dao: "nouns", wallet: WALLET });
    return { dao, wallet, amount: "3", asOf: "2026-09-14T00:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH };
  } });

  assert.deepEqual(await store.getHealth("nouns"), {
    healthy: true, refreshedAt: "2026-09-14T00:00:00.000Z", lastError: null,
  });
  assert.deepEqual(await store.getVotingPower("nouns", WALLET), {
    dao: "nouns", wallet: WALLET, amount: "3", asOf: "2026-09-14T00:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH,
  });
  assert.match(calls[0].sql, /sync_checkpoints/);
  assert.deepEqual(calls[0].values, ["nouns"]);
});

test("Postgres Gate proposal read is dedicated and uses persisted snapshot block provenance", async () => {
  const pool = { async query(sql, values) {
    const text = String(sql);
    assert.match(text, /provenance\.block_number::text AS "sourceBlock"/);
    assert.match(text, /SELECT r\.block_number,r\.block_hash,r\.ingested_at/);
    assert.doesNotMatch(text, /r\.observed_head AS block_number/);
    assert.match(text, /JOIN LATERAL/);
    assert.match(text, /r\.content_hash=p\.content_hash/);
    assert.match(text, /r\.source_id='nouns-subgraph'/);
    assert.match(text, /r\.source_record_key='proposal:' \|\| p\.proposal_id::text/);
    assert.deepEqual(values, ["nouns", "42"]);
    return { rows: [{
      chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
      proposalId: "42", title: "Canonical title", proposer: WALLET,
      refreshedAt: new Date("2026-09-14T00:00:00.000Z"), sourceBlock: "123",
      sourceBlockHash: BLOCK_HASH, effectiveStatus: "ACTIVE", contentHash: HASH,
      actions: [{ actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x" }],
    }] };
  } };
  const store = new PostgresGovernanceStore({ pool });
  assert.deepEqual(await store.getGateProposal("nouns", "42"), {
    chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
      proposalId: "42", title: "Canonical title", proposer: WALLET,
    refreshedAt: "2026-09-14T00:00:00.000Z", sourceBlock: "123",
    sourceBlockHash: BLOCK_HASH, effectiveStatus: "ACTIVE", contentHash: HASH,
    actions: [{ actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x" }],
  });
});

test("Postgres Gate proposal suppresses migrated open status even with fresh provenance", async () => {
  const pool = { async query(sql) {
    assert.match(String(sql), /p\.lifecycle_reason AS "lifecycleReason"/);
    assert.match(String(sql), /p\.normalized AS normalized/);
    return { rows: [{ proposalId: "42", title: "Old proposal", proposer: WALLET,
      normalized: { id: "42", state: "ACTIVE", effectiveStatus: "ACTIVE", outcome: "ACTIVE", endBlock: "3" },
      lifecycleReason: "migrated_from_outcome", effectiveStatus: "ACTIVE",
      refreshedAt: new Date("2026-09-25T00:00:00.000Z"), sourceBlock: "100",
      sourceBlockHash: BLOCK_HASH, contentHash: HASH, actions: [] }] };
  } };
  const store = new PostgresGovernanceStore({ pool });
  const gate = await store.getGateProposal("nouns", "42");
  assert.equal(gate.effectiveStatus, undefined);
});

test("Postgres proposal refresh conditionally rejects stale snapshots", async () => {
  const calls = [];
  const tx = new PostgresTransaction({ async query(sql) {
    calls.push(String(sql));
    if (/pg_advisory_xact_lock/.test(String(sql))) return { rows: [] };
    if (/SELECT block_number/.test(String(sql))) return { rows: [{ blockNumber: "200", observedHead: "200", blockHash: BLOCK_HASH,
      recordType: "proposal", proposalId: "42", contentHash: HASH.slice(2), payload: { id: "42" } }] };
    if (/UPDATE raw_governance_records/.test(String(sql))) return { rowCount: 0, rows: [] };
    throw new Error("stale proposal refresh must not update normalized state");
  } });
  const inserted = await tx.ingest({ raw: {
    daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:42", externalId: "42",
    chainId: 1, contractAddress: WALLET, transactionHash: null, logIndex: null, blockNumber: "199",
    blockHash: `0x${"ef".repeat(32)}`, recordType: "proposal", proposalId: "42", contentHash: HASH.slice(2),
    payload: { id: "42" }, sourceKind: "nouns-subgraph", sourceEndpoint: "https://example.test", observedHead: "199",
  }, proposal: { daoId: "nouns", proposalId: "42", contentHash: HASH.slice(2), normalized: { effectiveStatus: "ACTIVE" } } });
  assert.equal(inserted, false);
  assert.match(calls[2], /block_number<=\$4 AND observed_head<=\$6/);
});

test("Postgres governance proposal read uses canonical effective status and preserves stale source state", async () => {
  const pool = { async query(sql, values) {
    assert.match(String(sql), /proposal_actions/);
    assert.match(String(sql), /'actionIndex',a\.action_index/);
    assert.match(String(sql), /r\.record_type='proposal'/);
    assert.match(String(sql), /r\.content_hash=p\.content_hash/);
    assert.match(String(sql), /p\.effective_status AS "effectiveStatus"/);
    assert.match(String(sql), /p\.tracking_state AS "trackingState"/);
    assert.match(String(sql), /provenance\.ingested_at AS "refreshedAt"/);
    assert.deepEqual(values, ["nouns", "42"]);
    return { rows: [{
      dao: "nouns", proposalId: "42",
      normalized: { id: "42", state: "ACTIVE", sourceState: "ACTIVE", effectiveStatus: "DEFEATED", trackingState: "FINAL" },
      effectiveStatus: "DEFEATED", trackingState: "FINAL",
      refreshedAt: new Date("2026-09-14T00:00:00.000Z"), sourceBlock: "123", sourceBlockHash: BLOCK_HASH,
      contentHash: HASH, actions: [{ actionIndex: 0, target: WALLET, valueWei: "0", calldata: "0x" }],
    }] };
  } };
  const store = new PostgresGovernanceStore({ pool });
  assert.deepEqual(await store.getProposal("nouns", "42"), {
    dao: "nouns", proposalId: "42",
    normalized: { id: "42", state: "ACTIVE", sourceState: "ACTIVE", effectiveStatus: "DEFEATED", trackingState: "FINAL" },
    effectiveStatus: "DEFEATED", trackingState: "FINAL", nativeState: "DEFEATED", sourceState: "ACTIVE",
    refreshedAt: "2026-09-14T00:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH,
    contentHash: HASH, actions: [{ actionIndex: 0, target: WALLET, valueWei: "0", calldata: "0x" }],
  });
});
