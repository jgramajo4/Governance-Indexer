const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresGovernanceStore } = require('../src/postgres-store');
const { MemoryGovernanceStore } = require('../src/memory-store');
const { proposalContentHash } = require('../src/domain/nouns-history');

const url = process.env.GOVERNANCE_INDEXER_TEST_DATABASE_URL;
const disposable = url && new URL(url).pathname === '/governance_provenance_disposable';
const hash = (digit) => `0x${digit.repeat(64)}`;
const governor = '0x0000000000000000000000000000000000000001';
const sourceId = 'nouns-subgraph';
const oldHash = 'a'.repeat(64);
const payload = (description) => ({ id: '42', description, targets: [governor], values: ['0'], signatures: ['go()'], calldatas: ['0x'] });
const newHash = proposalContentHash(payload('new'));
const raw = { daoId: 'nouns', sourceId, sourceRecordKey: 'proposal:42', externalId: '42', chainId: 1,
  contractAddress: governor, blockNumber: '90', blockHash: hash('a'), recordType: 'proposal',
  proposalId: '42', contentHash: oldHash, payload: { id: '42', description: 'old' },
  sourceKind: 'nouns-subgraph', sourceEndpoint: 'https://index.example', observedHead: '90' };
function proposal(contentHash, title) {
  return { daoId: 'nouns', proposalId: '42', contentHash,
    normalized: { id: '42', title, description: title, state: 'ACTIVE', effectiveStatus: 'ACTIVE' },
    actions: [{ index: 0, target: governor, valueWei: '0', signature: 'go()', calldata: '0x' }] };
}
async function assertProvenance(store, readRaw) {
  const before = await readRaw();
  assert.equal((await store.getGateProposal('nouns', '42')).sourceBlockHash, hash('a'));
  await store.transaction(async (tx) => {
    await tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId, proposalId: '42', contentHash: newHash,
      snapshot: { blockNumber: 101, blockHash: hash('b') }, payload: payload('new') });
    await tx.upsertProposal(proposal(newHash, 'new'));
  });
  assert.deepEqual(await readRaw(), before, 'historical raw payload and its content/block provenance remain atomic');
  if (store.pool) {
    const evidence = (await store.pool.query('SELECT block_number::text AS block,block_hash AS hash,content_hash,payload FROM nouns_proposal_refreshes WHERE dao_id=$1 AND source_id=$2 AND proposal_id=$3', ['nouns', sourceId, '42'])).rows[0];
    assert.deepEqual(evidence, { block: '101', hash: hash('b'), content_hash: newHash, payload: payload('new') });
  } else assert.deepEqual(store.proposalRefreshes.get('nouns:nouns-subgraph:42').payload, payload('new'));
  const gate = await store.getGateProposal('nouns', '42');
  assert.equal(gate.title, 'new');
  assert.equal(gate.contentHash, `0x${newHash}`);
  assert.equal(gate.sourceBlockHash, hash('b'));
  assert.equal(gate.sourceBlock, '101');
  assert.deepEqual(gate.actions, [{ actionIndex: 0, target: governor, valueWei: '0', signature: 'go()', calldata: '0x' }]);
  assert.equal((await store.getGateTarget('nouns', 'proposal:42')).contentHash, `0x${newHash}`);
  await assert.rejects(store.transaction((tx) => tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId,
    proposalId: '42', contentHash: proposalContentHash(payload('forged')), snapshot: { blockNumber: 101, blockHash: hash('b') },
    payload: payload('forged') })), /conflicting/);
  assert.equal((await store.getGateProposal('nouns', '42')).title, 'new');
  await assert.rejects(store.transaction((tx) => tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId,
    proposalId: '42', contentHash: newHash, snapshot: { blockNumber: 102, blockHash: hash('c') },
    payload: payload('different') })), /invalid materialized/);
  await assert.rejects(store.transaction((tx) => tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId,
    proposalId: '42', contentHash: newHash, snapshot: { blockNumber: 102, blockHash: hash('c') },
    payload: { id: '43', description: 'new' } })), /invalid materialized/);
  await store.transaction(async (tx) => tx.upsertProposal(proposal(oldHash, 'old')));
  assert.equal((await store.getGateProposal('nouns', '42')).sourceBlockHash, hash('a'));
  assert.equal((await store.getGateProposal('nouns', '42')).sourceBlock, '90');
}

async function assertHistoricalReingest(store, readRaw) {
  const before = await readRaw();
  await assert.rejects(store.transaction((tx) => tx.ingest({
    raw: { ...raw, blockNumber: '101', observedHead: '101', blockHash: hash('b'),
      contentHash: newHash, sourceKind: 'nouns-governor-logs', payload: { id: '42', description: 'new' } },
    proposal: proposal(newHash, 'new'),
  })), /canonical event drift/);
  assert.deepEqual(await readRaw(), before, 'RPC replay cannot rewrite historical raw evidence');
  assert.equal((await store.getGateProposal('nouns', '42')).contentHash, hash('a'));
}

async function assertRpcReconciliation(store, readRaw) {
  const rpc = { ...raw, sourceRecordKey: 'proposal:43', externalId: '43', proposalId: '43',
    blockNumber: '106', observedHead: '106', blockHash: hash('b'), sourceKind: 'nouns-governor-logs',
    payload: { id: '43', createdBlock: '105', description: 'rpc' } };
  await store.transaction(async (tx) => {
    await tx.ingest({ raw: rpc, proposal: { ...proposal(oldHash, 'rpc'), proposalId: '43' } });
    await tx.refreshMaterializedProposal({ daoId: 'nouns', sourceId, proposalId: '43',
      contentHash: proposalContentHash({ ...payload('rpc'), id: '43' }), snapshot: { blockNumber: 107, blockHash: hash('c') },
      payload: { ...payload('rpc'), id: '43' } });
  });
  const args = { daoId: 'nouns', sourceId, fromBlock: 100, toBlock: 110, cutoverBlock: 100, createdIds: ['43'] };
  await store.transaction((tx) => tx.reconcileRpcProposals(args));
  assert.equal((await store.getGateProposal('nouns', '43')).proposalId, '43', 'creation in the new fork survives');
  await store.transaction((tx) => tx.reconcileRpcProposals({ ...args, fromBlock: 106, createdIds: [] }));
  assert.equal((await store.getGateProposal('nouns', '43')).proposalId, '43', 'creation outside replay survives');
  await store.transaction((tx) => tx.reconcileRpcProposals({ ...args, createdIds: [] }));
  assert.equal(await store.getGateProposal('nouns', '43'), null, 'orphan creation removed');
  assert.equal(await store.getProposal('nouns', '43'), null, 'normalized proposal and cascading actions removed');
  assert.equal((await store.getGateProposal('nouns', '42')).proposalId, '42', 'subgraph history survives');
  assert.deepEqual((await readRaw()).map((row) => row.sourceRecordKey), ['proposal:42']);
  if (store.proposalRefreshes) assert.equal(store.proposalRefreshes.has('nouns:nouns-subgraph:43'), false);
  else assert.equal((await store.pool.query("SELECT count(*)::int AS count FROM nouns_proposal_refreshes WHERE proposal_id=43")).rows[0].count, 0);
}

test('RPC replay does not rewrite historical subgraph raw evidence in memory', async () => {
  const store = new MemoryGovernanceStore();
  store.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
  store.ingest({ raw, proposal: proposal(oldHash, 'old') });
  await assertHistoricalReingest(store, async () => structuredClone(store.rawRecords[0]));
});

test('RPC replay does not rewrite historical subgraph raw evidence in PostgreSQL', { skip: !disposable && 'requires governance_provenance_disposable' }, async () => {
  const store = new PostgresGovernanceStore({ connectionString: url, maxConnections: 4 });
  try {
    await store.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await store.migrate({ ensureRoles: false });
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
      await tx.upsertSource({ daoId: 'nouns', id: sourceId, kind: 'nouns-subgraph', endpoint: 'https://index.example', fromBlock: 1 });
      await tx.ingest({ raw, proposal: proposal(oldHash, 'old') });
    });
    await assertHistoricalReingest(store, async () => (await store.pool.query(`
      SELECT block_number::text AS block,block_hash AS hash,observed_head::text AS head,
        content_hash AS content,payload,ingested_at AS ingested
      FROM raw_governance_records WHERE source_record_key='proposal:42'
    `)).rows[0]);
  } finally { await store.close(); }
});

test('RPC proposal creation reorg reconciliation removes only absent in-range creations in memory', async () => {
  const store = new MemoryGovernanceStore();
  store.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
  store.ingest({ raw, proposal: proposal(oldHash, 'old') });
  await assertRpcReconciliation(store, async () => store.rawRecords);
});

test('RPC proposal creation reorg reconciliation removes only absent in-range creations in PostgreSQL', { skip: !disposable && 'requires governance_provenance_disposable' }, async () => {
  const store = new PostgresGovernanceStore({ connectionString: url, maxConnections: 4 });
  try {
    await store.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await store.migrate({ ensureRoles: false });
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
      await tx.upsertSource({ daoId: 'nouns', id: sourceId, kind: 'nouns-subgraph', endpoint: 'https://index.example', fromBlock: 1 });
      await tx.ingest({ raw, proposal: proposal(oldHash, 'old') });
    });
    await assertRpcReconciliation(store, async () => (await store.pool.query('SELECT source_record_key AS "sourceRecordKey" FROM raw_governance_records ORDER BY source_record_key')).rows);
  } finally { await store.close(); }
});

test('historical materialization does not relabel raw evidence in memory', async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => {
    tx.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
    tx.ingest({ raw, proposal: proposal(oldHash, 'old') });
  });
  await assertProvenance(store, async () => structuredClone(store.rawRecords[0]));
});

test('historical materialization does not relabel raw evidence in PostgreSQL', { skip: !disposable && 'requires governance_provenance_disposable' }, async () => {
  const store = new PostgresGovernanceStore({ connectionString: url, maxConnections: 4 });
  try {
    await store.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await store.migrate({ ensureRoles: false });
    await store.transaction(async (tx) => {
      await tx.upsertDao({ id: 'nouns', chainId: 1, contractAddress: governor, fromBlock: 1 });
      await tx.upsertSource({ daoId: 'nouns', id: sourceId, kind: 'nouns-subgraph', endpoint: 'https://index.example', fromBlock: 1 });
      await tx.ingest({ raw, proposal: proposal(oldHash, 'old') });
    });
    await assertProvenance(store, async () => (await store.pool.query(`
      SELECT block_number::text AS block, block_hash AS hash, observed_head::text AS head,
        content_hash AS content, payload, ingested_at AS ingested
      FROM raw_governance_records WHERE source_record_key='proposal:42'
    `)).rows[0]);
  } finally { await store.close(); }
});
