const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AbiCoder, Interface, keccak256, toUtf8Bytes } = require('ethers');
const { NounsRpcSource, NounsSubgraphSource, NOUNS_DAO_DATA_PROXY, NOUNS_CANDIDATE_START_BLOCK } = require('../src/nouns-source');
const { DAO_CONFIGS } = require('../src/config');

const governorAddress = DAO_CONFIGS.nouns.currentGovernor;
const voter = '0x1234567890123456789012345678901234567890';
const hash = '0x' + 'ab'.repeat(32);
const tx = '0x' + 'cd'.repeat(32);
const eventAbi = new Interface([
  'event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)',
  'event VoteCast(address indexed voter,uint256 proposalId,uint8 support,uint256 votes,string reason)',
  'event ProposalDescriptionUpdated(uint256 indexed id,address indexed proposer,string description,string updateMessage)',
  'event ProposalTransactionsUpdated(uint256 indexed id,address indexed proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string updateMessage)',
  'event VoteCastWithClientId(address indexed voter,uint256 indexed proposalId,uint32 indexed clientId)',
]);
function log(event, args, blockNumber, index = 0) {
  const encoded = eventAbi.encodeEventLog(event, args);
  return { address: governorAddress, topics: encoded.topics, data: encoded.data, blockNumber, index, transactionHash: tx, blockHash: hash };
}
function fixture() {
  const calls = [];
  const proposal = {
    proposer: voter, startBlock: 205, endBlock: 250,
    againstVotes: 4n, forVotes: 9n, abstainVotes: 2n,
  };
  const created = log('ProposalCreated', [7, voter, [voter], [0], [''], ['0x1234'], 205, 250, '# Example\nBody'], 212);
  const vote = log('VoteCast', [voter, 7, 1, 3, 'reason'], 220, 2);
  const provider = {
    async send(method) { assert.equal(method, 'eth_chainId'); return '0x1'; },
    async getBlock(number) { calls.push(['block', number]); return { number, hash, timestamp: 1700000000 }; },
    async getBlockNumber() { return 250; },
    async getLogs(filter) { calls.push(['logs', filter]); return [created, vote].filter(x => x.blockNumber >= filter.fromBlock && x.blockNumber <= filter.toBlock && filter.topics[0].includes(x.topics[0])); },
  };
  const governor = {
    async proposals(id, overrides) { calls.push(['proposals', id, overrides]); return proposal; },
    async state(id, overrides) { calls.push(['state', id, overrides]); return 1n; },
    async quorumVotes(id, overrides) { calls.push(['quorum', id, overrides]); return 6n; },
    async getActions(id, overrides) { calls.push(['actions', id, overrides]); return [[voter], [0n], [''], ['0x1234']]; },
  };
  return { calls, provider, governor, created, vote };
}

test('RPC source discovers proposal at canonical snapshot with legacy identity and pinned state', async () => {
  const f = fixture();
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', fromBlock: 200, cutoverBlock: 210 });
  assert.equal(source.id, 'nouns-subgraph');
  assert.equal(await source.head(), 238);
  const records = await source.fetchProposals(200, 230, 238, { maxProposalId: '6', refreshProposals: [] });
  assert.equal(records.snapshot.blockHash, hash);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.raw.sourceRecordKey, 'proposal:7');
  assert.equal(record.raw.contractAddress, DAO_CONFIGS.nouns.contractAddress);
  assert.equal(record.raw.blockHash, hash);
  assert.equal(record.proposal.normalized.forVotes, '9');
  assert.equal(record.proposal.normalized.quorumVotes, '6');
  assert.equal(record.proposal.normalized.actions[0].calldata, '0x1234');
  for (const call of f.calls.filter(x => ['proposals', 'state', 'quorum', 'actions'].includes(x[0]))) assert.deepEqual(call[2], { blockTag: 238 });
  assert.equal(record.proposal.normalized.contentHash, record.raw.contentHash);
});

test('RPC votes ignore pre-cutover logs and preserve historical record identity', async () => {
  const f = fixture();
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', fromBlock: 200, cutoverBlock: 210 });
  const logs = await source.fetchRange(200, 230, 238);
  assert.equal(logs.length, 1);
  assert.equal(f.calls.find(x => x[0] === 'logs')[1].fromBlock, 210);
  const record = await source.normalizeLog(logs[0], 238);
  assert.equal(record.raw.sourceId, 'nouns-subgraph');
  assert.equal(record.raw.contractAddress, DAO_CONFIGS.nouns.contractAddress);
  assert.equal(record.raw.sourceRecordKey, `vote:${tx}-2`);
  assert.equal(record.vote.voteWeight, '3');
  assert.equal(record.vote.support, 'FOR');
  assert.equal(record.vote.proposalId, '7');
});

test('RPC retains objection-period state instead of deriving premature defeat', async () => {
  const f = fixture();
  f.governor.state = async () => 9n;
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const records = await source.fetchProposals(210, 230, 238, { refreshProposals: [] });
  assert.equal(records[0].proposal.normalized.state, 'OBJECTION_PERIOD');
  assert.equal(records[0].proposal.normalized.effectiveStatus, 'OBJECTION_PERIOD');
});

test('RPC vote associates client ID from canonical companion receipt', async () => {
  const f = fixture();
  const companion = log('VoteCastWithClientId', [voter, 7, 42], 220, 3);
  f.provider.getTransactionReceipt = async hashValue => { assert.equal(hashValue, tx); return { blockNumber: 220, blockHash: hash, logs: [f.vote, companion] }; };
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const record = await source.normalizeLog(f.vote, 238);
  assert.equal(record.vote.clientId, 42);
  assert.equal(record.vote.normalized?.clientId, 42, 'public vote projection reads normalized.clientId');
  assert.equal(record.raw.payload.clientId, 42);
});

test('candidate cache round-trips as JSON and rejects malformed persisted state', () => {
  const f = fixture();
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const eventLog = { blockNumber: 220, index: 0, transactionHash: tx };
  source.candidateCache = { snapshot: 17812145, blockHash: hash, states: new Map([['candidate', { content: { proposer: voter, slug: 'candidate', description: '# Candidate', proposalIdToUpdate: '0', encodedProposalHash: hash, targets: [voter], values: [3n], signatures: [''], calldatas: ['0x'] }, contentLog: { ...eventLog, blockNumber: 17812145 }, latestLog: { ...eventLog, blockNumber: 17812145 }, createdBlock: 17812145, canceled: false }]]), proposalIdsByHash: new Map([[hash, ['7']]]), timestamps: new Map([[17812145, 1700000000]]) };
  const exported = source.exportCandidateCache();
  const restored = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  restored.hydrateCandidateCache(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(restored.exportCandidateCache(), exported);
  assert.equal(restored.candidateCache.states.get('candidate').content.values[0], '3');
  assert.throws(() => restored.hydrateCandidateCache({ ...exported, blockHash: 'bad' }), /candidate cache/i);
  assert.deepEqual(restored.exportCandidateCache(), exported);
});

test('RPC rejects forged governance log block hash before indexing', async () => {
  const f = fixture();
  f.created.blockHash = '0x' + 'de'.repeat(32);
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  await assert.rejects(source.fetchProposals(210, 230, 238, { refreshProposals: [] }), /block hash|provenance/i);
});

test('RPC candidate scan bounds each log request and hydrates without rescanning history', async () => {
  const f = fixture();
  f.provider.getLogs = async filter => { f.calls.push(['logs', filter]); assert.ok(filter.toBlock - filter.fromBlock < 2000); return []; };
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const first = await source.fetchCandidates(17814146);
  assert.equal(first.length, 0);
  assert.equal(source.exportCandidateCache().snapshot, 17814146);
  const restored = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  restored.hydrateCandidateCache(JSON.parse(JSON.stringify(source.exportCandidateCache())));
  f.calls.length = 0;
  await restored.fetchCandidates(17814147);
  assert.ok(f.calls.filter(x => x[0] === 'logs').every(x => x[1].fromBlock === 17814147));
});

test('historical terminal proposal update loads persisted context and materializes without replacing immutable raw', async () => {
  const f = fixture();
  const update = log('ProposalDescriptionUpdated', [7, voter, '# Revised\nBody', 'edit'], 234, 3);
  f.provider.getLogs = async (filter) => { f.calls.push(['logs', filter]); return [update].filter(x => x.blockNumber >= filter.fromBlock && x.blockNumber <= filter.toBlock && filter.topics[0].includes(x.topics[0])); };
  const row = { proposalId: '7', normalized: { description: '# Old\nBody', title: 'Old', proposer: voter, createdBlock: '205', createdAt: new Date(1700000000000).toISOString() } };
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const records = await source.fetchProposals(231, 238, 238, { refreshProposals: [], loadProposal: async id => { assert.equal(id, '7'); return row; } });
  assert.equal(records.length, 1);
  assert.equal(records[0].raw, undefined);
  assert.equal(records[0].proposal.normalized.description, '# Revised\nBody');
  assert.equal(records[0].proposal.normalized.createdBlock, '205');
  assert.equal(records[0].proposal.normalized.contentHash, records[0].proposal.contentHash);
});

test('transaction update refreshes actions and exposes canonical onchain content hash', async () => {
  const f = fixture();
  const update = log('ProposalTransactionsUpdated', [7, voter, [voter], [1], [''], ['0x9876'], 'edit'], 234, 3);
  f.provider.getLogs = async filter => [update].filter(x => x.blockNumber >= filter.fromBlock && x.blockNumber <= filter.toBlock && filter.topics[0].includes(x.topics[0]));
  f.governor.getActions = async () => [[voter], [1n], [''], ['0x9876']];
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const row = { proposalId: '7', normalized: { description: '# Example\nBody', title: 'Example', proposer: voter, createdBlock: '205', createdAt: new Date(1700000000000).toISOString() } };
  const records = await source.fetchProposals(231, 238, 238, { refreshProposals: [], loadProposal: async () => row });
  assert.equal(records[0].proposal.normalized.actions[0].valueWei, '1');
  assert.equal(records[0].proposal.normalized.actions[0].calldata, '0x9876');
  assert.match(records[0].proposal.normalized.onchainContentHash, /^0x[0-9a-f]{64}$/);
});

test('RPC refreshes mutable proposal without scanning historical logs and fails on bad chain', async () => {
  const f = fixture();
  const source = new NounsRpcSource({ provider: f.provider, governor: f.governor, rpcUrl: 'https://rpc.example', cutoverBlock: 210 });
  const row = { proposalId: '7', normalized: { description: '# Example\nBody', title: 'Example', proposer: voter, createdBlock: '200', createdAt: new Date(1700000000000).toISOString(), startBlock: '205', endBlock: '250', actions: [] } };
  const records = await source.fetchProposals(231, 238, 238, { refreshProposals: [row], maxProposalId: '7' });
  assert.equal(records.length, 1);
  assert.equal(records[0].proposal.proposalId, '7');
  assert.equal(records[0].raw, undefined); // preserve original subgraph raw provenance
  assert.equal(f.calls.filter(x => x[0] === 'logs').length, 1);
  f.provider.send = async () => '0x89';
  await assert.rejects(source.fetchProposals(231, 238, 238, { refreshProposals: [row] }), /mainnet/);
});

const candidateAbi = new Interface([
  'event ProposalCandidateCreated(address indexed msgSender,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string slug,uint256 proposalIdToUpdate,bytes32 encodedProposalHash)',
]);

function candidateFixture({ forgedKind, missingHash = false, changeTimestampBlock = false } = {}) {
  const number = NOUNS_CANDIDATE_START_BLOCK;
  const proposalNumber = number + 1;
  const snapshot = number + 2;
  const goodHash = hash;
  const staleHash = '0x' + 'ef'.repeat(32);
  const proposer = voter;
  const description = '# Candidate';
  const contentHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    [proposer, keccak256('0x'), keccak256('0x'), keccak256('0x'), keccak256('0x'), keccak256(toUtf8Bytes(description))],
  ));
  const candidate = candidateAbi.encodeEventLog('ProposalCandidateCreated', [proposer, [], [], [], [], description, 'candidate', 0, contentHash]);
  const proposal = eventAbi.encodeEventLog('ProposalCreated', [7, proposer, [], [], [], [], 1, 2, description]);
  const entries = [
    { address: NOUNS_DAO_DATA_PROXY, ...candidate, blockNumber: number, blockHash: forgedKind === 'candidate' ? staleHash : goodHash, index: 0, transactionHash: tx },
    { address: governorAddress, ...proposal, blockNumber: proposalNumber, blockHash: forgedKind === 'proposal' ? staleHash : goodHash, index: 0, transactionHash: tx },
  ];
  if (missingHash) delete entries[0].blockHash;
  let candidateBlockReads = 0;
  const provider = {
    async send() { return '0x1'; },
    async getBlock(blockNumber) {
      if (blockNumber === number) candidateBlockReads++;
      const blockHash = changeTimestampBlock && blockNumber === number && candidateBlockReads > 1 ? staleHash : goodHash;
      return { number: blockNumber, hash: blockHash, timestamp: 1700000000 };
    },
    async getLogs(filter) {
      return entries.filter(entry => entry.address.toLowerCase() === filter.address.toLowerCase()
        && entry.blockNumber >= filter.fromBlock && entry.blockNumber <= filter.toBlock);
    },
  };
  return { provider, snapshot };
}

for (const Source of [NounsRpcSource, NounsSubgraphSource]) {
  const label = Source.name;
  function source(provider) {
    return Source === NounsRpcSource
      ? new Source({ provider, rpcUrl: 'https://rpc.example', cutoverBlock: 210 })
      : new Source({ provider, endpoint: 'https://subgraph.example' });
  }
  test(`${label} candidate scan rejects a valid ABI log on a stale candidate fork without caching it`, async () => {
    const f = candidateFixture({ forgedKind: 'candidate' });
    const instance = source(f.provider);
    await assert.rejects(instance.fetchCandidates(f.snapshot), /candidate.*(hash|provenance|canonical)/i);
    assert.equal(instance.candidateCache, undefined);
  });
  test(`${label} candidate scan rejects a stale proposal match without caching it`, async () => {
    const f = candidateFixture({ forgedKind: 'proposal' });
    const instance = source(f.provider);
    await assert.rejects(instance.fetchCandidates(f.snapshot), /proposal.*(hash|provenance|canonical)/i);
    assert.equal(instance.candidateCache, undefined);
  });
  test(`${label} candidate scan rejects a missing event block hash`, async () => {
    const f = candidateFixture({ missingHash: true });
    await assert.rejects(source(f.provider).fetchCandidates(f.snapshot), /candidate.*(hash|provenance|canonical)/i);
  });
  test(`${label} candidate scan rejects a timestamp block replaced during scanning`, async () => {
    const f = candidateFixture({ changeTimestampBlock: true });
    await assert.rejects(source(f.provider).fetchCandidates(f.snapshot), /timestamp.*(hash|provenance|canonical)/i);
  });
  test(`${label} candidate scan rebuilds unauthenticated persisted cache before reuse`, async () => {
    const f = candidateFixture();
    const instance = source(f.provider);
    instance.candidateCache = { snapshot: f.snapshot - 1, blockHash: hash, states: new Map(),
      proposalIdsByHash: new Map([['0x' + 'ff'.repeat(32), ['999']]]), timestamps: new Map() };
    await instance.fetchCandidates(f.snapshot);
    assert.equal(instance.candidateCache.proposalIdsByHash.has('0x' + 'ff'.repeat(32)), false);
  });
  test(`${label} candidate scan accepts canonical candidate and proposal logs`, async () => {
    const f = candidateFixture();
    const records = await source(f.provider).fetchCandidates(f.snapshot);
    assert.deepEqual(records[0].target.matchingProposalIds, ['7']);
    assert.equal(records[0].target.latestVersion.createdTimestamp, '1700000000');
  });
}
