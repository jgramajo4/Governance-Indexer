const assert = require('node:assert/strict');
const test = require('node:test');
const { candidateTargetId } = require('../src/domain/nouns-candidate');
const { MemoryGovernanceStore } = require('../src/memory-store');
const { createReadOnlyApi } = require('../src/api');
const { GovernanceSyncWorker } = require('../src/worker');
const { DAO_CONFIGS } = require('../src/config');

const PROPOSER = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const CONTENT_HASH = `0x${'cd'.repeat(32)}`;
const targetId = candidateTargetId(PROPOSER, 'slug');

function record(overrides = {}) {
  const target = {
    dao: 'nouns', targetId, kind: 'candidate', proposer: PROPOSER, slug: 'slug',
    title: 'Candidate title', description: '# Candidate title', nativeState: 'ACTIVE',
    eligibility: 'PRE_VOTE', mappingVersion: 'nouns-candidate-lifecycle/1', contentHash: CONTENT_HASH,
    actions: [{ actionIndex: 0, target: TARGET, valueWei: '0', signature: '', calldata: '0x' }],
    latestVersion: { id: 'v1', createdBlock: '200', createdTimestamp: '1700000000', updateMessage: '' },
    ...overrides,
  };
  return {
    raw: {
      daoId: 'nouns', sourceId: 'nouns-subgraph', sourceRecordKey: targetId, externalId: 'display', chainId: 1,
      contractAddress: '0xf790a5f59678dd733fb3de93493a91f472ca1365', transactionHash: null, logIndex: null,
      blockNumber: '200', blockHash: BLOCK_HASH, recordType: 'proposal_candidate', proposalId: null,
      contentHash: target.contentHash.slice(2), payload: { stable: true }, sourceKind: 'nouns-subgraph',
      sourceEndpoint: 'https://example.test', observedHead: '200',
    }, target,
  };
}

function snapshotRows(rows, blockHash = BLOCK_HASH) {
  Object.defineProperty(rows, 'snapshot', { value: { blockNumber: 200, blockHash } });
  return rows;
}

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('memory candidate persistence updates lifecycle without changing stable identity', async () => {
  const store = new MemoryGovernanceStore({ clock: () => new Date('2026-09-18T00:00:00Z') });
  store.ingest(record());
  const first = await store.getGateTarget('nouns', targetId);
  assert.equal(first.targetId, targetId);
  assert.equal(first.kind, 'candidate');
  assert.equal(first.eligibility, 'PRE_VOTE');
  assert.equal(first.sourceBlock, '200');
  assert.equal(first.sourceBlockHash, BLOCK_HASH);

  const closed = record({ nativeState: 'CANCELED', eligibility: 'CLOSED',
    latestVersion: { id: 'v2', createdBlock: '201', createdTimestamp: '1700000001', updateMessage: 'withdrawn' } });
  closed.raw.blockNumber = '201'; closed.raw.observedHead = '201'; closed.raw.contentHash = closed.target.contentHash.slice(2);
  store.ingest(closed);
  const second = await store.getGateTarget('nouns', targetId);
  assert.equal(second.targetId, targetId);
  assert.equal(second.eligibility, 'CLOSED');
  assert.equal(second.sourceBlock, '201');
});

test('candidate persistence binds proposer plus slug identity, validates canonical actions, and reconciles removals', async () => {
  const store = new MemoryGovernanceStore();
  assert.throws(() => store.ingest(record({ targetId: `${targetId.slice(0, -1)}0` })), /identity mismatch/);
  assert.throws(() => store.ingest(record({ actions: [{ actionIndex: 1, target: TARGET,
    valueWei: '0', signature: '', calldata: '0x' }] })), /action index/);

  const candidate = record();
  store.ingest(candidate);
  assert.ok(await store.getGateTarget('nouns', targetId));
  store.reconcileCandidates({ daoId: 'nouns', sourceId: 'nouns-subgraph', records: [] });
  assert.equal(await store.getGateTarget('nouns', targetId), null);
});

test('candidate persistence rejects content rewrites at the same canonical snapshot', async () => {
  const store = new MemoryGovernanceStore();
  store.ingest(record());
  const rewritten = record({ title: 'Tampered title', contentHash: `0x${'ef'.repeat(32)}` });
  rewritten.raw.contentHash = rewritten.target.contentHash.slice(2);
  rewritten.raw.payload = { stable: false };
  assert.throws(() => store.ingest(rewritten), /canonical candidate drift/);
  assert.equal((await store.getGateTarget('nouns', targetId)).title, 'Candidate title');
});

test('worker rejects divergent empty target snapshots before candidate reconciliation', async () => {
  const store = new MemoryGovernanceStore();
  const source = {
    id: 'nouns-subgraph', fromBlock: 200, replayBlocks: 0, config: DAO_CONFIGS.nouns,
    async head() { return 200; }, async fetchRange() { return []; },
    async fetchProposals() { return snapshotRows([], BLOCK_HASH); },
    async fetchCandidates() { return snapshotRows([], `0x${'ef'.repeat(32)}`); },
  };
  await assert.rejects(new GovernanceSyncWorker({ store, sources: { nouns: source } }).syncDao('nouns'), /snapshot hash changed/);
});

test('candidate ingestion failure cannot advance a healthy checkpoint', async () => {
  const store = new MemoryGovernanceStore();
  const malformed = record({ kind: 'proposal' });
  const source = {
    id: 'nouns-subgraph', fromBlock: 200, replayBlocks: 0, config: DAO_CONFIGS.nouns,
    async head() { return 200; }, async fetchRange() { return []; },
    async fetchProposals() { return snapshotRows([]); },
    async fetchCandidates() { return snapshotRows([malformed]); },
  };
  await assert.rejects(new GovernanceSyncWorker({ store, sources: { nouns: source } }).syncDao('nouns'), /candidate target kind/);
  const checkpoint = store.getCheckpoint('nouns', 'nouns-subgraph');
  assert.equal(checkpoint.nextBlock, 200);
  assert.match(checkpoint.lastError, /candidate target kind/);
});

test('dedicated Gate target endpoint projects candidates without a numeric proposal id', async () => {
  const store = new MemoryGovernanceStore({ clock: () => new Date('2026-09-18T00:00:00Z') });
  store.ingest(record());
  await withServer(createReadOnlyApi({ store }), async (base) => {
    const response = await fetch(`${base}/v1/gate/daos/nouns/targets/${encodeURIComponent(targetId)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.targetId, targetId);
    assert.equal(body.dao, 'nouns');
    assert.equal(body.kind, 'candidate');
    assert.equal(body.proposalId, undefined);
    assert.equal(body.eligibility, 'PRE_VOTE');
    assert.deepEqual(Object.keys(body).sort(), [
      'actions', 'contentHash', 'dao', 'description', 'eligibility', 'kind', 'mappingVersion', 'nativeState', 'proposer',
      'refreshedAt', 'slug', 'sourceBlock', 'sourceBlockHash', 'targetId', 'title',
    ]);
  });
});
