const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Interface } = require('ethers');
const { PostgresGovernanceStore } = require('../src/postgres-store');
const { GovernanceSyncWorker } = require('../src/worker');
const { NounsRpcSource } = require('../src/nouns-source');
const { DAO_CONFIGS } = require('../src/config');
const { normalizeProposal } = require('../src/domain/nouns-history');
const { MemoryGovernanceStore } = require('../src/memory-store');

const url = process.env.GOVERNANCE_INDEXER_TEST_DATABASE_URL;
const skip = url && new URL(url).pathname.slice(1) === 'governance_nouns_e2e_disposable'
  ? false : 'requires disposable governance_nouns_e2e_disposable PostgreSQL DB';
const N = 26088822;
const governorAddress = DAO_CONFIGS.nouns.currentGovernor;
const proposer = '0x1234567890123456789012345678901234567890';
const target = '0x2345678901234567890123456789012345678901';
const oldDescription = '# Old title\nOriginal text';
const updatedDescription = '# New title\nChanged by governor';
const createdDescription = '# Fresh proposal\nOn chain';
const blockHash = (n, fork = 0) => `0x${(n + fork).toString(16).padStart(64, '0')}`;
const eventInterface = new Interface([
  'event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)',
  'event ProposalDescriptionUpdated(uint256 indexed id,address indexed proposer,string description,string updateMessage)',
  'event ProposalTransactionsUpdated(uint256 indexed id,address indexed proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string updateMessage)',
  'event VoteCast(address indexed voter,uint256 proposalId,uint8 support,uint256 votes,string reason)',
]);
function event(name, args, height, index) {
  const encoded = eventInterface.encodeEventLog(name, args);
  return { address: governorAddress, blockNumber: height, transactionIndex: index,
    index, transactionHash: `0x${(height * 100 + index).toString(16).padStart(64, '0')}`,
    blockHash: blockHash(height), topics: encoded.topics, data: encoded.data };
}
function fakeChain() {
  const calls = [];
  const chain = {
    logs: [
      event('ProposalDescriptionUpdated', [41, proposer, updatedDescription, 'edit'], N + 1, 0),
      event('ProposalTransactionsUpdated', [41, proposer, [target], [2n], [''], ['0x1234'], 'change actions'], N + 1, 1),
      event('ProposalCreated', [42, proposer, [target], [0n], [''], ['0xabcd'], N + 4, N + 9, createdDescription], N + 2, 2),
      event('VoteCast', [proposer, 41, 1, 3n, 'for'], N + 2, 3),
    ],
    fail: false, fork: 0, calls,
    provider: {
      async send(method) { assert.equal(method, 'eth_chainId'); return '0x1'; },
      async getBlockNumber() { return N + 20; },
      async getBlock(height) { calls.push(['block', height]); return { number: height, hash: blockHash(height, chain.fork), timestamp: 1700000000 + height - N }; },
      async getLogs(filter) {
        calls.push(['logs', filter.fromBlock, filter.toBlock]);
        if (chain.fail) throw new Error('RPC logs unavailable');
        const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map(x => x.toLowerCase());
        return chain.logs.filter(log => addresses.includes(log.address.toLowerCase()) && log.blockNumber >= filter.fromBlock
          && log.blockNumber <= filter.toBlock && (!filter.topics?.[0] || filter.topics[0].includes(log.topics[0])));
      },
    },
    governor: {
      async proposals(id, tag) { assert.equal(tag.blockTag, N + 2); return { id: BigInt(id), proposer, creationBlock: BigInt(id === '41' ? N - 50 : N + 2), startBlock: BigInt(N + 4), endBlock: BigInt(N + 9), forVotes: 3n, againstVotes: 0n, abstainVotes: 0n }; },
      async state(_id, tag) { assert.equal(tag.blockTag, N + 2); return 0n; },
      async quorumVotes(_id, tag) { assert.equal(tag.blockTag, N + 2); return 2n; },
      async getActions(id, tag) { assert.equal(tag.blockTag, N + 2); return [[target], [BigInt(id === '41' ? 2 : 0)], [''], [id === '41' ? '0x1234' : '0xabcd']]; },
    },
  };
  return chain;
}
function legacyProposal() {
  const raw = { id: '41', title: 'Old title', description: oldDescription, status: 'ACTIVE', proposer: { id: proposer },
    targets: [target], values: ['0'], signatures: [''], calldatas: ['0xbeef'],
    createdTimestamp: '1700000000', createdBlock: String(N - 50), startBlock: String(N - 48), endBlock: String(N + 9),
    quorumVotes: '2', forVotes: '0', againstVotes: '0', abstainVotes: '0' };
  const normalized = { ...normalizeProposal(raw, { subgraphBlock: String(N) }), dao: 'nouns', chainId: 1, venue: 'governor', timing: 'block' };
  return {
    raw: { daoId: 'nouns', sourceId: 'nouns-subgraph', sourceRecordKey: 'proposal:41', externalId: '41',
      chainId: 1, contractAddress: DAO_CONFIGS.nouns.contractAddress, blockNumber: String(N), blockHash: blockHash(N),
      recordType: 'proposal', proposalId: '41', contentHash: normalized.contentHash,
      payload: { id: '41', title: raw.title, description: raw.description, proposer: raw.proposer, targets: raw.targets,
        values: raw.values, signatures: raw.signatures, calldatas: raw.calldatas, createdTimestamp: raw.createdTimestamp,
        createdBlock: raw.createdBlock, startBlock: raw.startBlock, endBlock: raw.endBlock },
      sourceKind: 'nouns-subgraph', sourceEndpoint: 'https://historic.example', observedHead: String(N) },
    proposal: { daoId: 'nouns', proposalId: '41', contentHash: normalized.contentHash, normalized, actions: normalized.actions },
  };
}
async function setup(store) {
  await store.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await store.pool.query(await fs.readFile(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8'));
  await store.pool.query(await fs.readFile(path.join(__dirname, '../migrations/003_proposal_lifecycle.sql'), 'utf8'));
  await store.pool.query(await fs.readFile(path.join(__dirname, '../migrations/004_nouns_candidates.sql'), 'utf8'));
  await store.transaction(async tx => {
    await tx.upsertDao({ ...DAO_CONFIGS.nouns });
    await tx.upsertSource({ daoId: 'nouns', id: 'nouns-subgraph', kind: 'nouns-subgraph', endpoint: 'https://historic.example', fromBlock: DAO_CONFIGS.nouns.fromBlock });
    await tx.ingest(legacyProposal());
    await tx.setCheckpoint({ daoId: 'nouns', sourceId: 'nouns-subgraph', nextBlock: N + 1, finalizedHead: N });
  });
  await store.migrate({ ensureRoles: false });
}
test('fresh Nouns RPC failure leaves no unmarked checkpoint and can retry', async () => {
  const store = new MemoryGovernanceStore();
  let cutover = null;
  store.getRpcCutoverBlock = () => cutover;
  store.freezeRpcCutoverBlock = (_dao, _source, block) => { cutover = block; };
  let fail = true;
  const source = {
    id: 'nouns-subgraph', config: DAO_CONFIGS.nouns, fromBlock: N + 1, replayBlocks: 64,
    rpcUrl: 'https://rpc.fixture', async head() { if (fail) throw new Error('RPC unavailable'); return N + 1; },
    async fetchProposals() { return Object.assign([], { snapshot: { blockNumber: N + 1, blockHash: blockHash(N + 1) } }); },
    async fetchCandidates() { return Object.assign([], { snapshot: { blockNumber: N + 1, blockHash: blockHash(N + 1) } }); },
    async fetchRange() { return []; },
  };
  const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 1000 });
  await assert.rejects(worker.syncDao('nouns'), /RPC unavailable/);
  assert.equal(await store.getCheckpoint('nouns', source.id), null);
  fail = false;
  await assert.doesNotReject(worker.syncDao('nouns'));
});

test('scheduled Nouns RPC full pass still refreshes open proposals with no new events', async () => {
  const store = new MemoryGovernanceStore();
  const old = legacyProposal();
  await store.transaction(async tx => {
    tx.upsertDao(DAO_CONFIGS.nouns);
    tx.upsertSource({ daoId: 'nouns', id: 'nouns-subgraph', kind: 'nouns-rpc', endpoint: 'https://rpc.fixture', fromBlock: N });
    tx.ingest(old);
    tx.setCheckpoint({ daoId: 'nouns', sourceId: 'nouns-subgraph', nextBlock: N + 1, finalizedHead: N });
  });
  // Model a store with a committed cutover marker; no new logs arrive.
  store.getRpcCutoverBlock = () => N + 1;
  const seen = [];
  const source = {
    id: 'nouns-subgraph', config: DAO_CONFIGS.nouns, fromBlock: N - 50, replayBlocks: 64,
    rpcUrl: 'https://rpc.fixture', async head() { return N + 2; },
    async fetchProposals(_from, _to, _snapshot, context) {
      seen.push(context.refreshProposals.map(x => x.proposalId));
      return Object.assign([], { snapshot: { blockNumber: N + 2, blockHash: blockHash(N + 2) } });
    },
    async fetchCandidates() { return Object.assign([], { snapshot: { blockNumber: N + 2, blockHash: blockHash(N + 2) } }); },
    async fetchRange() { return []; },
  };
  await new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 1000 }).syncDao('nouns', { fullProposalScan: true });
  assert.deepEqual(seen, [['41']]);
});

test('real PostgreSQL: legacy proposal and RPC actions/description/new proposal/vote coexist across replay and failure', { skip }, async () => {
  const store = new PostgresGovernanceStore({ connectionString: url, maxConnections: 4 });
  try {
    await setup(store);
    const old = await store.getGateProposal('nouns', '41');
    assert.equal(old.title, 'Old title');
    const chain = fakeChain();
    const source = new NounsRpcSource({ provider: chain.provider, governor: chain.governor, rpcUrl: 'https://rpc.fixture', finalityDepth: 18 });
    const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100, retries: 1 });
    const sync = () => worker.syncDao('nouns', { toBlock: N + 2, fullProposalScan: false });
    await sync();
    const checkpoint = await store.getCheckpoint('nouns', 'nouns-subgraph');
    assert.equal(checkpoint.nextBlock, String(N + 3));
    assert.equal(await store.getRpcCutoverBlock('nouns', 'nouns-subgraph'), N + 1);
    const historical = await store.getGateProposal('nouns', '41');
    assert.equal(historical.title, 'New title');
    assert.equal(historical.actions[0].valueWei, '2');
    assert.notEqual(historical.contentHash, old.contentHash);
    assert.equal(historical.sourceBlockHash, blockHash(N + 2));
    const fresh = await store.getGateProposal('nouns', '42');
    assert.equal(fresh.title, 'Fresh proposal');
    assert.equal(fresh.sourceBlockHash, blockHash(N + 2));
    assert.equal(fresh.governorAddress, governorAddress);
    const votes = await store.listVotes({ daoId: 'nouns', limit: 10 });
    assert.equal(votes.items.length, 1);
    assert.equal(votes.items[0].logIndex, 3);
    await sync();
    assert.equal((await store.listVotes({ daoId: 'nouns', limit: 10 })).items.length, 1);
    // Replace a vote in the replay window with a different canonical log at the same height.
    chain.fork = 10000;
    const originalVote = chain.logs.find(x => x.topics[0] === eventInterface.getEvent('VoteCast').topicHash);
    chain.logs = chain.logs.filter(x => x !== originalVote).map(x => ({ ...x, blockHash: blockHash(x.blockNumber, chain.fork) }));
    chain.logs.push({ ...event('VoteCast', [proposer, 41, 0, 5n, 'against'], N + 2, 4), blockHash: blockHash(N + 2, chain.fork) });
    await sync();
    const replacement = await store.listVotes({ daoId: 'nouns', limit: 10 });
    assert.equal(replacement.items.length, 1);
    assert.equal(replacement.items[0].logIndex, 4);
    assert.equal(replacement.items[0].support, 'AGAINST');
    assert.equal((await store.getGateProposal('nouns', '42')).sourceBlockHash, blockHash(N + 2, chain.fork));
    // Another replay-window fork drops the proposal creation entirely.
    chain.logs = chain.logs.filter(x => x.topics[0] !== eventInterface.getEvent('ProposalCreated').topicHash);
    await sync();
    assert.equal(await store.getGateProposal('nouns', '42'), null, 'orphan creation must not remain Gate-visible');
    assert.equal((await store.getGateProposal('nouns', '41')).proposalId, '41', 'pre-cutover proposal survives');
    chain.fail = true;
    await assert.rejects(sync(), /RPC logs unavailable/);
    assert.equal((await store.getCheckpoint('nouns', 'nouns-subgraph')).nextBlock, String(N + 3));
  } finally { await store.close(); }
});
