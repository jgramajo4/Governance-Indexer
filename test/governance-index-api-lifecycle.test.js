const test = require("node:test");
const assert = require("node:assert/strict");
const { presentProposal } = require("../src/domain/lifecycle");
const { MemoryGovernanceStore } = require("../src/memory-store");
const { PostgresGovernanceStore } = require("../src/postgres-store");
const { createReadOnlyApi } = require("../src/api");

async function request(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function migratedNouns992() {
  // Shape of a row after 003_proposal_lifecycle: columns are correct, JSON is not.
  return {
    daoId: "nouns",
    proposalId: "992",
    contentHash: "a".repeat(64),
    effectiveStatus: "DEFEATED",
    trackingState: "FINAL",
    lifecycleReason: "migrated_from_outcome",
    normalized: {
      id: "992",
      contentHash: "a".repeat(64),
      title: "Stale ACTIVE blob",
      description: "historical",
      proposer: "0x0000000000000000000000000000000000000001",
      state: "ACTIVE",
      outcome: "DEFEATED",
      createdBlock: "1",
      createdAt: "2024-01-01T00:00:00.000Z",
      startBlock: "10",
      endBlock: "20",
      quorumVotes: "1",
      forVotes: "0",
      againstVotes: "2",
      abstainVotes: "0",
      actions: [],
    },
  };
}

function refreshedNouns996() {
  return {
    daoId: "nouns",
    proposalId: "996",
    contentHash: "b".repeat(64),
    effectiveStatus: "PENDING",
    trackingState: "HOT",
    lifecycleReason: "voting_open",
    normalized: {
      id: "996",
      contentHash: "b".repeat(64),
      title: "Open",
      description: "fresh",
      proposer: "0x0000000000000000000000000000000000000001",
      state: "PENDING",
      outcome: "PENDING",
      sourceState: "PENDING",
      effectiveStatus: "PENDING",
      trackingState: "HOT",
      lifecycleReason: "voting_open",
      createdBlock: "1",
      createdAt: "2024-01-01T00:00:00.000Z",
      startBlock: "10",
      endBlock: "999999",
      quorumVotes: "1",
      forVotes: "0",
      againstVotes: "0",
      abstainVotes: "0",
      actions: [],
    },
  };
}

test("presentProposal does not upgrade raw ACTIVE/outcome ACTIVE to effective status", () => {
  const projected = presentProposal({ id: "998", state: "ACTIVE", outcome: "ACTIVE" }, {});
  assert.equal(projected.effectiveStatus, undefined);
  assert.equal(projected.outcome, "ACTIVE");
  const persisted = presentProposal({ id: "998", state: "ACTIVE", outcome: "ACTIVE", effectiveStatus: "ACTIVE" },
    { effectiveStatus: "DEFEATED" });
  assert.equal(persisted.effectiveStatus, "DEFEATED");
});

test("migration-derived open state is never a canonical effective status", async () => {
  const old = migratedNouns992();
  const row = {
    ...old, proposalId: "998", effectiveStatus: "ACTIVE", outcome: "ACTIVE",
    trackingState: "HOT", lifecycleReason: "migrated_from_outcome",
    normalized: { ...old.normalized, id: "998", state: "ACTIVE", outcome: "ACTIVE",
      effectiveStatus: "ACTIVE", endBlock: "3" },
  };
  const projected = presentProposal(row.normalized, row);
  assert.equal(projected.effectiveStatus, undefined);
  const store = new MemoryGovernanceStore();
  store.proposals.push(row);
  const result = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals/998");
  assert.equal(result.status, 200);
  assert.equal(result.body.effectiveStatus, undefined);
  assert.equal(result.body.state, "ACTIVE");
  store.rawRecords.push({ daoId: "nouns", proposalId: "998", recordType: "proposal",
    sourceId: "nouns-subgraph", sourceRecordKey: "proposal:998", contentHash: row.contentHash,
    blockNumber: "100", blockHash: `0x${"1".repeat(64)}`, ingestedAt: "2026-09-25T00:00:00.000Z" });
  const gate = await request(createReadOnlyApi({ store }), "/v1/gate/daos/nouns/proposals/998");
  assert.equal(gate.status, 200);
  assert.equal(gate.body.effectiveStatus, undefined);
  const target = await request(createReadOnlyApi({ store }), "/v1/gate/daos/nouns/targets/proposal:998");
  assert.equal(target.status, 200);
  assert.equal(target.body.effectiveStatus, undefined);
});

test("Postgres public detail and list suppress migrated open status", async () => {
  const row = { ...migratedNouns992(), proposalId: "998", effectiveStatus: "ACTIVE",
    trackingState: "HOT", lifecycleReason: "migrated_from_outcome",
    normalized: { ...migratedNouns992().normalized, id: "998", state: "ACTIVE",
      outcome: "ACTIVE", effectiveStatus: "ACTIVE", endBlock: "3" } };
  const pool = { async query(sql) {
    const text = String(sql);
    assert.match(text, /lifecycle_reason AS "lifecycleReason"/);
    if (text.includes("LIMIT $2")) return { rows: [row] };
    return { rows: [{ dao: "nouns", ...row, contentHash: `0x${row.contentHash}`,
      refreshedAt: new Date("2026-09-25T00:00:00.000Z") }] };
  } };
  const store = new PostgresGovernanceStore({ pool });
  const direct = await store.getProposal("nouns", "998");
  assert.equal(direct.effectiveStatus, undefined);
  assert.equal(direct.nativeState, undefined);
  for (const path of ["/v1/daos/nouns/proposals/998", "/v1/daos/nouns/proposals?limit=10"]) {
    const response = await request(createReadOnlyApi({ store }), path);
    assert.equal(response.status, 200);
    const proposal = response.body.items?.[0] ?? response.body;
    assert.equal(proposal.effectiveStatus, undefined, path);
    assert.equal(proposal.state, "ACTIVE", path);
  }
});

test("public proposal API refuses a stored DAO that differs from the requested DAO", async () => {
  const wrong = { ...refreshedNouns996().normalized, dao: "ens" };
  const store = {
    async getProposal() { return wrong; },
    async listProposals() { return { items: [wrong], nextCursor: null }; },
  };
  for (const route of ["/v1/daos/nouns/proposals/996", "/v1/daos/nouns/proposals?limit=10"]) {
    const response = await request(createReadOnlyApi({ store }), route);
    assert.equal(response.status, 500, route);
    assert.equal(response.body.error, "internal_error", route);
  }
});

test("public proposal API refuses inconsistent stored IDs and identities", async () => {
  const good = refreshedNouns996();
  const cases = [
    { ...good, normalized: { ...good.normalized, id: "997" } },
    { ...good, identity: { dao: "ens", chainId: 1,
      governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "996" } },
    { ...good, normalized: { ...good.normalized, identity: { dao: "nouns", chainId: 1,
      governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "997" } } },
  ];
  for (const row of cases) {
    const store = {
      async getProposal() { return row; },
      async listProposals() { return { items: [row], nextCursor: null }; },
    };
    for (const route of ["/v1/daos/nouns/proposals/996", "/v1/daos/nouns/proposals?limit=10"]) {
      const response = await request(createReadOnlyApi({ store }), route);
      assert.equal(response.status, 500, route);
      assert.equal(response.body.error, "internal_error", route);
    }
  }
});

test("public proposal detail rejects a different stored proposal even when its row is internally consistent", async () => {
  const wrong = refreshedNouns996();
  wrong.proposalId = "997";
  wrong.normalized.id = "997";
  const response = await request(createReadOnlyApi({ store: {
    async getProposal() { return wrong; },
  } }), "/v1/daos/nouns/proposals/996");
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "internal_error");
});

test("Postgres list rejects a normalized ID that differs from the stored proposal ID", async () => {
  const row = { ...refreshedNouns996(), proposalId: "997", daoId: "nouns" };
  const pool = { async query() { return { rows: [row] }; } };
  const store = new PostgresGovernanceStore({ pool });
  const response = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals?limit=10");
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "internal_error");
});

test("public proposal API refuses conflicting stored DAO and chain fields", async () => {
  const good = refreshedNouns996();
  for (const row of [
    { ...good, daoId: "ens", normalized: { ...good.normalized, dao: "nouns" } },
    { ...good, normalized: { ...good.normalized, chainId: 10 } },
  ]) {
    const store = {
      async getProposal() { return row; },
      async listProposals() { return { items: [row], nextCursor: null }; },
    };
    for (const route of ["/v1/daos/nouns/proposals/996", "/v1/daos/nouns/proposals?limit=10"]) {
      const response = await request(createReadOnlyApi({ store }), route);
      assert.equal(response.status, 500, route);
      assert.equal(response.body.error, "internal_error", route);
    }
  }
});

test("memory proposal detail rejects normalized identity mismatched with the stored row", async () => {
  const store = new MemoryGovernanceStore();
  store.proposals.push({ ...refreshedNouns996(), normalized: { ...refreshedNouns996().normalized, id: "997" } });
  const response = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals/996");
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "internal_error");
});

test("memory detail rejects conflicting persisted identity evidence", async () => {
  for (const fields of [
    { chainId: 10 },
    { governorAddress: "0x0000000000000000000000000000000000000001" },
    { identity: { dao: "ens", chainId: 1,
      governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "996" } },
  ]) {
    const store = new MemoryGovernanceStore();
    store.proposals.push({ ...refreshedNouns996(), ...fields });
    const response = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals/996");
    assert.equal(response.status, 500, JSON.stringify(fields));
  }
});

test("memory proposal list rejects conflicting persisted identity evidence", async () => {
  for (const fields of [
    { chainId: 10 },
    { governorAddress: "0x0000000000000000000000000000000000000001" },
    { identity: { dao: "ens", chainId: 1,
      governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "996" } },
  ]) {
    const store = new MemoryGovernanceStore();
    store.proposals.push({ ...refreshedNouns996(), ...fields });
    const response = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals?limit=10");
    assert.equal(response.status, 500, JSON.stringify(fields));
  }
});

test("memory detail and list reject normalized identity evidence conflicting with the stored row", async () => {
  const good = refreshedNouns996();
  for (const fields of [
    { dao: "ens" },
    { chainId: 10 },
    { governorAddress: "0x0000000000000000000000000000000000000001" },
    { identity: { dao: "ens", chainId: 1,
      governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "996" } },
  ]) {
    const store = new MemoryGovernanceStore();
    store.proposals.push({ ...good, dao: "nouns", chainId: 1,
      governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
      identity: { dao: "nouns", chainId: 1,
        governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: "996" },
      normalized: { ...good.normalized, ...fields } });
    for (const route of ["/v1/daos/nouns/proposals/996", "/v1/daos/nouns/proposals?limit=10"]) {
      const response = await request(createReadOnlyApi({ store }), route);
      assert.equal(response.status, 500, `${route}: ${JSON.stringify(fields)}`);
    }
  }
});

test("Postgres detail rejects mismatched stored DAO and missing normalized ID", async () => {
  for (const row of [
    { ...refreshedNouns996(), dao: "ens", daoId: undefined },
    { ...refreshedNouns996(), dao: "nouns", normalized: { title: "Missing ID" } },
  ]) {
    const store = new PostgresGovernanceStore({ pool: { async query() { return { rows: [row] }; } } });
    const response = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals/996");
    assert.equal(response.status, 500);
  }
});

test("persisted lifecycle tracking outranks stale normalized tracking", () => {
  const row = migratedNouns992();
  row.normalized = { ...row.normalized, effectiveStatus: "ACTIVE", trackingState: "HOT" };
  const projected = presentProposal(row.normalized, row);
  assert.equal(projected.effectiveStatus, "DEFEATED");
  assert.equal(projected.trackingState, "FINAL");
});

test("presentProposal overlays persisted columns without rewriting state", () => {
  const row = migratedNouns992();
  const presented = presentProposal(row.normalized, row);
  assert.equal(presented.state, "ACTIVE");
  assert.equal(presented.sourceState, "ACTIVE");
  assert.equal(presented.outcome, "DEFEATED");
  assert.equal(presented.effectiveStatus, "DEFEATED");
  assert.equal(presented.trackingState, "FINAL");
  assert.equal(row.normalized.effectiveStatus, undefined);
  assert.equal(row.normalized.trackingState, undefined);
});

test("memory proposal refresh replaces coherent snapshot provenance for unchanged material", async () => {
  let now = "2026-09-14T00:00:00.000Z";
  const store = new MemoryGovernanceStore({ clock: () => new Date(now) });
  const proposal = migratedNouns992();
  const makeRecord = (blockNumber, blockHash) => ({
    raw: {
      daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:992",
      chainId: 1, contractAddress: proposal.normalized.proposer, transactionHash: null, logIndex: null,
      blockNumber, blockHash, observedHead: blockNumber, recordType: "proposal", proposalId: "992",
      contentHash: proposal.contentHash, payload: { id: "992" }, sourceKind: "nouns-subgraph",
      sourceEndpoint: "https://index.example",
    },
    proposal,
  });
  store.ingest(makeRecord("100", `0x${"1".repeat(64)}`));
  now = "2026-09-14T00:05:00.000Z";
  const refreshed = makeRecord("105", `0x${"2".repeat(64)}`);
  store.reconcileProposals({ daoId: "nouns", sourceId: "nouns-subgraph", records: [refreshed] });
  assert.equal(store.ingest(refreshed), false);

  assert.deepEqual(await store.getGateProposal("nouns", "992"), {
    chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
    proposalId: "992", title: proposal.normalized.title, proposer: proposal.normalized.proposer,
    refreshedAt: now, sourceBlock: "105", sourceBlockHash: `0x${"2".repeat(64)}`,
    effectiveStatus: "DEFEATED", contentHash: `0x${proposal.contentHash}`, actions: [],
  });
  const gateResponse = await request(createReadOnlyApi({ store }), "/v1/gate/daos/nouns/proposals/992");
  assert.equal(gateResponse.status, 200);
  assert.equal(gateResponse.body.proposalId, "992");
  assert.equal(gateResponse.body.chainId, 1);
  assert.equal(gateResponse.body.governorAddress, "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d");
  assert.equal(gateResponse.body.title, proposal.normalized.title);
  assert.equal(gateResponse.body.proposer, proposal.normalized.proposer);

  now = "2026-09-14T00:10:00.000Z";
  const stale = makeRecord("101", `0x${"3".repeat(64)}`);
  stale.proposal = { ...proposal, normalized: { ...proposal.normalized, effectiveStatus: "ACTIVE" } };
  assert.equal(store.ingest(stale), false);
  assert.deepEqual(await store.getGateProposal("nouns", "992"), {
    chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
    proposalId: "992", title: proposal.normalized.title, proposer: proposal.normalized.proposer,
    refreshedAt: "2026-09-14T00:05:00.000Z", sourceBlock: "105",
    sourceBlockHash: `0x${"2".repeat(64)}`, effectiveStatus: "DEFEATED",
    contentHash: `0x${proposal.contentHash}`, actions: [],
  });

  store.rawRecords.push({ ...store.rawRecords[0], sourceId: "unrelated", sourceRecordKey: "proposal:unrelated",
    blockNumber: "999", blockHash: `0x${"4".repeat(64)}`, ingestedAt: "2026-09-14T00:20:00.000Z" });
  store.proposalActions.push({ daoId: "nouns", proposalId: "992", index: 0, target: proposal.normalized.proposer,
    valueWei: "0", signature: "", calldata: "0x", privateDestination: "secret@example.test" });
  const projection = await store.getGateProposal("nouns", "992");
  assert.equal(projection.sourceBlock, "105");
  assert.deepEqual(projection.actions, [{ actionIndex: 0, target: proposal.normalized.proposer,
    valueWei: "0", signature: "", calldata: "0x" }]);

  store.proposalActions.push({ daoId: "nouns", proposalId: "992", index: 0, target: proposal.normalized.proposer,
    valueWei: "0", signature: "", calldata: "0x" });
  await assert.rejects(store.getGateProposal("nouns", "992"), /action index/);

  const before = structuredClone({ proposals: store.proposals, actions: store.proposalActions });
  for (const actions of [null, false, 0, "", new Array(1)]) {
    assert.throws(() => store.upsertProposal({ ...proposal, actions }), /proposal action/);
    assert.deepEqual({ proposals: store.proposals, actions: store.proposalActions }, before);
  }
});

test("a migration-style memory row is hydrated on get and list", async () => {
  const store = new MemoryGovernanceStore();
  store.proposals.push(migratedNouns992());
  store.proposals.push(refreshedNouns996());

  const single = await store.getProposal("nouns", "992");
  assert.equal(single.state, "ACTIVE");
  assert.equal(single.sourceState, "ACTIVE");
  assert.equal(single.outcome, "DEFEATED");
  assert.equal(single.effectiveStatus, "DEFEATED");
  assert.equal(single.trackingState, "FINAL");

  const fresh = await store.getProposal("nouns", "996");
  assert.equal(fresh.state, "PENDING");
  assert.equal(fresh.effectiveStatus, "PENDING");
  assert.equal(fresh.trackingState, "HOT");

  const page = await store.listProposals({ daoId: "nouns", limit: 10 });
  const byId = Object.fromEntries(page.items.map((item) => [item.id, item]));
  assert.equal(byId["992"].effectiveStatus, "DEFEATED");
  assert.equal(byId["992"].state, "ACTIVE");
  assert.equal(byId["996"].effectiveStatus, "PENDING");
});

test("Nouns proposals 993-998 retain titles across descending pagination", async () => {
  const store = new MemoryGovernanceStore();
  const titles = new Map([
    ["993", "Nounworks for Nouns"],
    ["994", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
    ["995", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
    ["996", "Camp operational costs 2026/2027"],
    ["997", "Unwrap & Stake Treasury WETH"],
    ["998", "Unwrap & Stake Treasury WETH"],
  ]);
  for (const [proposalId, title] of [...titles].reverse()) {
    store.upsertProposal({
      daoId: "nouns", proposalId, contentHash: proposalId.padStart(64, "0"), actions: [],
      normalized: { id: proposalId, title, state: "ACTIVE", effectiveStatus: "ACTIVE" },
    });
  }

  const seen = [];
  let cursor;
  do {
    const page = await store.listProposals({ daoId: "nouns", limit: 2, cursor });
    seen.push(...page.items.map(({ id, title }) => [id, title]));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(seen, [...titles].reverse());
  assert.equal(new Map(seen).size, 6);
});

test("API list and detail expose the same hydrated lifecycle fields", async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => tx.upsertDao({ id: "nouns", chainId: 1 }));
  store.proposals.push(migratedNouns992());
  store.proposals.push(refreshedNouns996());

  const detail = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals/992");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.state, "ACTIVE");
  assert.equal(detail.body.sourceState, "ACTIVE");
  assert.equal(detail.body.outcome, "DEFEATED");
  assert.equal(detail.body.effectiveStatus, "DEFEATED");
  assert.equal(detail.body.trackingState, "FINAL");

  const list = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals?limit=10");
  assert.equal(list.status, 200);
  const item = list.body.items.find((row) => row.id === "992");
  assert.deepEqual(
    {
      state: item.state,
      sourceState: item.sourceState,
      outcome: item.outcome,
      effectiveStatus: item.effectiveStatus,
      trackingState: item.trackingState,
    },
    {
      state: "ACTIVE",
      sourceState: "ACTIVE",
      outcome: "DEFEATED",
      effectiveStatus: "DEFEATED",
      trackingState: "FINAL",
    },
  );
  const open = list.body.items.find((row) => row.id === "996");
  assert.equal(open.effectiveStatus, "PENDING");
  assert.equal(open.trackingState, "HOT");
});
