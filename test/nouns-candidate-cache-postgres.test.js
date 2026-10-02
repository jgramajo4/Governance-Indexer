const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresGovernanceStore } = require('../src/postgres-store');
const { GovernanceSyncWorker } = require('../src/worker');
const { proposalContentHash } = require('../src/domain/nouns-history');

const url = process.env.GOVERNANCE_INDEXER_TEST_DATABASE_URL;
const skip = !url || new URL(url).pathname !== '/governance_provenance_disposable'
  ? 'requires governance_provenance_disposable' : false;
const sourceId = 'nouns-subgraph';
const hash = (char) => `0x${char.repeat(64)}`;
const governor = '0x0000000000000000000000000000000000000001';
const proposalPayload = (description) => ({ id: '42', description, targets: [governor], values: ['0'], signatures: ['go()'], calldatas: ['0x'] });
async function setup() {
  const store = new PostgresGovernanceStore({ connectionString: url, maxConnections: 4 });
  await store.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await store.migrate({ ensureRoles: false });
  await store.transaction(async (tx) => {
    await tx.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
    await tx.upsertSource({ daoId: 'nouns', id: sourceId, kind: 'nouns-subgraph', endpoint: 'https://index.example', fromBlock: 1 });
  });
  return store;
}
const snapshot = (block, blockHash = hash('a')) => ({ snapshot: block, blockHash, states: [['candidate', { createdBlock: 1 }]], proposalIdsByHash: [['hash', ['42']]], timestamps: [[1, 123]] });

test('candidate cache survives restart and rolls back with checkpoint on write failure', { skip }, async () => {
  const store = await setup();
  try {
    const original = snapshot(100);
    await store.transaction(async (tx) => {
      await tx.setCandidateSnapshot({ daoId: 'nouns', sourceId, checkpointBlock: 100, checkpointHash: original.blockHash, snapshot: original });
      await tx.setCheckpoint({ daoId: 'nouns', sourceId, nextBlock: 101, finalizedHead: 100 });
    });
    assert.deepEqual(await store.getCandidateSnapshot('nouns', sourceId), { checkpointBlock: 100, checkpointHash: original.blockHash, snapshot: original });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.setCandidateSnapshot({ daoId: 'nouns', sourceId, checkpointBlock: 101, checkpointHash: hash('b'), snapshot: snapshot(101, hash('b')) });
      await tx.setCheckpoint({ daoId: 'nouns', sourceId, nextBlock: 102, finalizedHead: 101 });
      throw new Error('candidate ingest failed');
    }), /candidate ingest failed/);
    assert.equal((await store.getCandidateSnapshot('nouns', sourceId)).checkpointBlock, 100);
    assert.equal((await store.getCheckpoint('nouns', sourceId)).nextBlock, '101');
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: 'ens', chainId: 1, contractAddress: governor, fromBlock: 1 });
      await tx.upsertSource({ daoId: 'ens', id: 'ens', kind: 'ens', endpoint: 'https://index.example', fromBlock: 1 });
      await tx.setCandidateSnapshot({ daoId: 'ens', sourceId: 'ens', checkpointBlock: 100, checkpointHash: hash('b'), snapshot: snapshot(100, hash('b')) });
    });
    assert.equal((await store.getCandidateSnapshot('nouns', sourceId)).checkpointHash, hash('a'));
  } finally { await store.close(); }
});

test('worker hydrates before candidate fetch and only persists complete fetch with checkpoint', { skip }, async () => {
  const store = await setup();
  try {
    const initial = snapshot(100);
    await store.transaction(async (tx) => {
      await tx.setCandidateSnapshot({ daoId: 'nouns', sourceId, checkpointBlock: 100, checkpointHash: initial.blockHash, snapshot: initial });
      await tx.setCheckpoint({ daoId: 'nouns', sourceId, nextBlock: 101, finalizedHead: 100 });
    });
    let hydrated;
    const source = {
      id: sourceId, config: { source: { kind: 'nouns-subgraph', endpoint: 'https://index.example' } }, fromBlock: 1, replayBlocks: 0,
      hydrateCandidateCache(value) { hydrated = value; },
      exportCandidateCache() { return hydrated ? snapshot(101, hash('b')) : null; },
      fetchProposals: async () => Object.assign([], { snapshot: { blockNumber: 101, blockHash: hash('b') } }),
      async fetchCandidates() { assert.deepEqual(hydrated, initial); return Object.assign([], { snapshot: { blockNumber: 101, blockHash: hash('b') } }); },
      fetchRange: async () => [], normalizeLog: async (x) => x,
    };
    const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, logger: { info() {}, warn() {}, error() {} } });
    await worker.syncDao('nouns', { fromBlock: 101, toBlock: 101, fullProposalScan: false });
    assert.equal((await store.getCheckpoint('nouns', sourceId)).nextBlock, '102');
    assert.equal((await store.getCandidateSnapshot('nouns', sourceId)).checkpointBlock, 101);
  } finally { await store.close(); }
});

test('fresh RPC source freezes a cutover boundary for subsequent restarts', { skip }, async () => {
  const store = await setup();
  try {
    const source = {
      id: sourceId, config: { source: { kind: 'nouns-rpc', endpoint: 'ethereum-json-rpc' } },
      rpcUrl: 'ethereum-json-rpc', fromBlock: 10, replayBlocks: 0,
      fetchProposals: async () => [], fetchRange: async () => [], normalizeLog: async (x) => x,
    };
    const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, logger: { info() {}, warn() {}, error() {} } });
    await worker.syncDao('nouns', { fromBlock: 10, toBlock: 10, fullProposalScan: false });
    assert.equal(await store.getRpcCutoverBlock('nouns', sourceId), 10);
    assert.equal(source.cutoverBlock, 10);
    await worker.syncDao('nouns', { fromBlock: 11, toBlock: 11, fullProposalScan: false });
    await store.pool.query("UPDATE governance_sources SET config=config-'rpcCutoverBlock' WHERE dao_id='nouns' AND id=$1", [sourceId]);
    await assert.rejects(worker.syncDao('nouns', { fromBlock: 12, toBlock: 12 }), /cutover marker is missing/);
  } finally { await store.close(); }
});

test('materialized historical RPC update keeps Gate provenance joined to updated content', { skip }, async () => {
  const store = await setup();
  try {
    await store.transaction(async (tx) => {
      await tx.ingest(proposal(90, 'a'.repeat(64), 'old'));
      await tx.setCheckpoint({ daoId: 'nouns', sourceId, nextBlock: 100, finalizedHead: 99 });
    });
    await store.pool.query("UPDATE governance_sources SET config=jsonb_set(config,'{rpcCutoverBlock}','100'::jsonb) WHERE dao_id='nouns' AND id=$1", [sourceId]);
    const changed = proposal(101, proposalContentHash(proposalPayload('new')), 'new', hash('b'));
    const source = {
      id: sourceId, config: { source: { kind: 'nouns-rpc', endpoint: 'ethereum-json-rpc' } },
      rpcUrl: 'ethereum-json-rpc', fromBlock: 1, replayBlocks: 0,
      fetchProposals: async () => Object.assign([{ proposal: changed.proposal, payload: proposalPayload('new') }], { snapshot: { blockNumber: 101, blockHash: hash('b') } }),
      fetchRange: async () => [], normalizeLog: async (x) => x,
    };
    await new GovernanceSyncWorker({ store, sources: { nouns: source }, logger: { info() {}, warn() {}, error() {} } })
      .syncDao('nouns', { fromBlock: 101, toBlock: 101, fullProposalScan: false });
    assert.equal((await store.getGateProposal('nouns', '42')).title, 'new');
    assert.equal((await store.getGateProposal('nouns', '42')).sourceBlockHash, hash('b'));
    const raw = (await store.pool.query("SELECT payload FROM raw_governance_records WHERE source_record_key='proposal:42'")).rows[0];
    assert.equal(raw.payload.description, 'old');
  } finally { await store.close(); }
});

test('candidate raw provenance replaces same-height reorg hash without regressing head', { skip }, async () => {
  const store = await setup();
  try {
    const raw = { daoId: 'nouns', sourceId, sourceRecordKey: 'candidate:one', externalId: 'one', chainId: 1,
      contractAddress: governor, transactionHash: hash('f'), logIndex: 0, blockNumber: '101', blockHash: hash('a'),
      recordType: 'proposal_candidate', payload: { id: 'one' }, sourceKind: 'nouns-governor-logs',
      sourceEndpoint: 'ethereum-json-rpc', observedHead: '101' };
    assert.equal(await store.transaction((tx) => tx.ingest({ raw })), true);
    assert.equal(await store.transaction((tx) => tx.ingest({ raw: { ...raw, blockHash: hash('b') } })), false);
    assert.equal((await store.pool.query("SELECT block_hash FROM raw_governance_records WHERE source_record_key='candidate:one'")).rows[0].block_hash, hash('b'));
  } finally { await store.close(); }
});

function proposal(block, contentHash, description, blockHash = hash('a')) {
  return { raw: { daoId: 'nouns', sourceId, sourceRecordKey: 'proposal:42', externalId: '42', chainId: 1,
    contractAddress: governor, blockNumber: String(block), blockHash, recordType: 'proposal', proposalId: '42', contentHash,
    payload: { id: '42', description }, sourceKind: 'nouns-subgraph', sourceEndpoint: 'https://index.example', observedHead: String(block) },
  proposal: { daoId: 'nouns', proposalId: '42', contentHash, normalized: { id: '42', title: description, description, state: 'ACTIVE', effectiveStatus: 'ACTIVE' }, actions: [{ index: 0, target: governor, valueWei: '0', signature: 'go()', calldata: '0x' }] } };
}

test('historical RPC refresh updates provenance hash for Gate but preserves legacy identity and rejects stale writes', { skip }, async () => {
  const store = await setup();
  try {
    const legacy = proposal(90, 'a'.repeat(64), 'old');
    await store.transaction(async (tx) => {
      await tx.ingest(legacy);
      await tx.setCheckpoint({ daoId: 'nouns', sourceId, nextBlock: 100, finalizedHead: 99 });
    });
    await store.pool.query("UPDATE governance_sources SET config=jsonb_set(config,'{rpcCutoverBlock}','100'::jsonb) WHERE dao_id='nouns' AND id=$1", [sourceId]);
    assert.equal(await store.getRpcCutoverBlock('nouns', sourceId), 100);
    assert.equal((await store.getGateProposal('nouns', '42')).title, 'old');
    const changed = proposal(101, proposalContentHash(proposalPayload('new')), 'new', hash('b'));
    changed.raw.sourceKind = 'nouns-rpc';
    changed.raw.sourceEndpoint = 'ethereum-json-rpc';
    await assert.rejects(store.transaction((tx) => tx.ingest(changed)), /canonical event drift/);
    await store.transaction(async (tx) => {
      await tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId, proposalId: '42',
        contentHash: changed.proposal.contentHash, snapshot: { blockNumber: 101, blockHash: hash('b') },
        payload: proposalPayload('new') });
      await tx.upsertProposal(changed.proposal);
    });
    const gate = await store.getGateProposal('nouns', '42');
    assert.equal(gate.title, 'new');
    assert.equal(gate.contentHash, `0x${changed.proposal.contentHash}`);
    assert.equal(gate.sourceBlockHash, hash('b'));
    const row = (await store.pool.query("SELECT block_number::text AS block, payload, source_kind,content_hash FROM raw_governance_records WHERE source_record_key='proposal:42'")).rows[0];
    assert.equal(row.block, '90');
    assert.deepEqual(row.payload, legacy.raw.payload);
    assert.equal(row.source_kind, 'nouns-subgraph');
    assert.equal(row.content_hash, legacy.raw.contentHash);
    const forged = proposal(101, 'c'.repeat(64), 'forged', hash('b'));
    forged.raw.sourceKind = 'nouns-rpc';
    await assert.rejects(store.transaction((tx) => tx.ingest(forged)), /canonical event drift/);
    assert.equal((await store.getGateProposal('nouns', '42')).title, 'new');
    const reorg = proposal(101, proposalContentHash(proposalPayload('reorg')), 'reorg', hash('c'));
    await store.transaction(async (tx) => {
      await tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId, proposalId: '42',
        contentHash: reorg.proposal.contentHash, snapshot: { blockNumber: 101, blockHash: hash('c') },
        payload: proposalPayload('reorg') });
      await tx.upsertProposal(reorg.proposal);
    });
    assert.equal((await store.getGateProposal('nouns', '42')).title, 'reorg');
    assert.equal((await store.getGateProposal('nouns', '42')).sourceBlockHash, hash('c'));
    await assert.rejects(store.transaction((tx) => tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId,
      proposalId: '42', contentHash: proposalContentHash(proposalPayload('stale')), snapshot: { blockNumber: 100, blockHash: hash('d') },
      payload: proposalPayload('stale') })), /stale/);
    assert.equal((await store.getGateProposal('nouns', '42')).title, 'reorg');
    await assert.rejects(store.transaction((tx) => tx.ingest({ ...changed, raw: { ...changed.raw, proposalId: '43' } })), /drift|identity/i);
  } finally { await store.close(); }
});
