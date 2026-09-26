const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AbiCoder,
  Interface,
  concat,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} = require('ethers');
const {
  NounsSubgraphSource,
  NOUNS_CANDIDATE_START_BLOCK,
  NOUNS_DAO_DATA_PROXY,
} = require('../src/nouns-source');
const { DAO_CONFIGS } = require('../src/config');
const { GovernanceSyncWorker } = require('../src/worker');
const { MemoryGovernanceStore } = require('../src/memory-store');

const PROPOSER = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const OTHER_TARGET = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TX = `0x${'cd'.repeat(32)}`;
const TX2 = `0x${'ef'.repeat(32)}`;
const SNAPSHOT = NOUNS_CANDIDATE_START_BLOCK + 20;

const candidateInterface = new Interface([
  'event ProposalCandidateCreated(address indexed msgSender,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string slug,uint256 proposalIdToUpdate,bytes32 encodedProposalHash)',
  'event ProposalCandidateUpdated(address indexed msgSender,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string slug,uint256 proposalIdToUpdate,bytes32 encodedProposalHash,string reason)',
  'event ProposalCandidateCanceled(address indexed msgSender,string slug)',
]);
const proposalInterface = new Interface([
  'event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)',
]);

function proposalCandidateHash({ proposer, targets, values, signatures, calldatas, description, proposalIdToUpdate = 0n }) {
  const packedAddresses = concat(targets.map((target) => zeroPadValue(target, 32)));
  const packedValues = concat(values.map((value) => zeroPadValue(toBeHex(value), 32)));
  const signatureHashes = concat(signatures.map((signature) => keccak256(toUtf8Bytes(signature))));
  const calldataHashes = concat(calldatas.map((calldata) => keccak256(calldata)));
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    [proposer, keccak256(packedAddresses), keccak256(packedValues), keccak256(signatureHashes), keccak256(calldataHashes), keccak256(toUtf8Bytes(description))],
  );
  return keccak256(BigInt(proposalIdToUpdate) > 0n
    ? concat([zeroPadValue(toBeHex(proposalIdToUpdate), 32), encoded]) : encoded);
}

function log(iface, event, args, { blockNumber, transactionHash = TX, index = 0, transactionIndex = 0, address = NOUNS_DAO_DATA_PROXY }) {
  const encoded = iface.encodeEventLog(iface.getEvent(event), args);
  return { address, blockNumber, transactionHash, transactionIndex, index, topics: encoded.topics, data: encoded.data };
}

function candidateEvent(event, overrides = {}) {
  const value = {
    proposer: PROPOSER,
    targets: [TARGET],
    values: [0n],
    signatures: ['transfer(address,uint256)'],
    calldatas: ['0x1234'],
    description: 'prefix# **Fund __public__ goods**\nBody',
    slug: 'fund-public-goods',
    proposalIdToUpdate: 0n,
    encodedProposalHash: null,
    reason: 'latest edit',
    ...overrides,
  };
  value.encodedProposalHash ||= proposalCandidateHash(value);
  const args = [value.proposer, value.targets, value.values, value.signatures, value.calldatas,
    value.description, value.slug, value.proposalIdToUpdate, value.encodedProposalHash];
  if (event === 'ProposalCandidateUpdated') args.push(value.reason);
  return log(candidateInterface, event, args, {
    blockNumber: value.blockNumber ?? NOUNS_CANDIDATE_START_BLOCK,
    transactionHash: value.transactionHash ?? TX,
    index: value.index ?? 0,
    transactionIndex: value.transactionIndex ?? 0,
  });
}

function canceledEvent(slug, overrides = {}) {
  return log(candidateInterface, 'ProposalCandidateCanceled', [overrides.proposer ?? PROPOSER, slug], {
    blockNumber: overrides.blockNumber ?? NOUNS_CANDIDATE_START_BLOCK + 2,
    transactionHash: overrides.transactionHash ?? TX2,
    index: overrides.index ?? 0,
  });
}

function proposalEvent(candidate, id = 42n, overrides = {}) {
  const hash = proposalCandidateHash(candidate);
  assert.equal(hash.toLowerCase(), candidate.encodedProposalHash.toLowerCase(), 'fixture candidate hash');
  return log(proposalInterface, 'ProposalCreated', [id, candidate.proposer, candidate.targets, candidate.values,
    candidate.signatures, candidate.calldatas, 100n, 200n, candidate.description], {
    address: DAO_CONFIGS.nouns.contractAddress,
    blockNumber: overrides.blockNumber ?? NOUNS_CANDIDATE_START_BLOCK + 5,
    transactionHash: overrides.transactionHash ?? TX2,
  });
}

function sourceFor({ candidateLogs = [], proposalLogs = [], blockHash = BLOCK_HASH, chainId = '0x1' } = {}) {
  const calls = [];
  const blockCalls = [];
  const provider = {
    async send(method) { calls.push(['send', method]); return chainId; },
    async getBlock(number) {
      calls.push(['getBlock', number]); blockCalls.push(number);
      return { number, hash: typeof blockHash === 'function' ? blockHash(number) : blockHash,
        timestamp: 1_700_000_000 + number };
    },
    async getLogs(filter) {
      calls.push(['getLogs', filter]);
      const rows = getAddress(filter.address) === getAddress(NOUNS_DAO_DATA_PROXY) ? candidateLogs : proposalLogs;
      return rows.filter((entry) => Number(entry.blockNumber) >= Number(filter.fromBlock)
        && Number(entry.blockNumber) <= Number(filter.toBlock));
    },
  };
  const source = new NounsSubgraphSource({ provider, fetch: async () => { throw new Error('candidate reconstruction must not query the subgraph'); } });
  return { source, calls, blockCalls };
}

test('canonical candidate logs reconstruct latest content, exact actions, title, promotion, and pinned provenance', async () => {
  const created = candidateEvent('ProposalCandidateCreated', { description: '# Old title' });
  const updatedMaterial = {
    proposer: PROPOSER,
    targets: [OTHER_TARGET, TARGET],
    values: [7n, 0n],
    signatures: ['', 'transfer(address,uint256)'],
    calldatas: ['0xabcd', '0x1234'],
    description: 'prefix# **Fund __public__ goods**\nBody',
  };
  updatedMaterial.encodedProposalHash = proposalCandidateHash(updatedMaterial);
  const updated = candidateEvent('ProposalCandidateUpdated', {
    ...updatedMaterial,
    blockNumber: NOUNS_CANDIDATE_START_BLOCK + 1,
    transactionHash: TX2,
  });
  const { source, calls, blockCalls } = sourceFor({ candidateLogs: [updated, created], proposalLogs: [proposalEvent(updatedMaterial)] });

  const records = await source.fetchCandidates(SNAPSHOT);
  assert.equal(records.length, 1);
  const [{ raw, target }] = records;
  const slugHash = keccak256(toUtf8Bytes('fund-public-goods')).toLowerCase();
  assert.equal(target.targetId, `candidate:${PROPOSER}:${slugHash}`);
  assert.equal(target.title, 'Fund public goods');
  assert.equal(target.description, updatedMaterial.description);
  assert.equal(target.contentHash, updatedMaterial.encodedProposalHash.toLowerCase());
  assert.deepEqual(target.actions, [
    { actionIndex: 0, target: OTHER_TARGET, valueWei: '7', signature: '', calldata: '0xabcd' },
    { actionIndex: 1, target: TARGET, valueWei: '0', signature: 'transfer(address,uint256)', calldata: '0x1234' },
  ]);
  assert.equal(target.eligibility, 'CLOSED');
  assert.deepEqual(target.matchingProposalIds, ['42']);
  assert.deepEqual(target.latestVersion, {
    id: `${TX2}-0`, createdBlock: String(NOUNS_CANDIDATE_START_BLOCK + 1),
    createdTimestamp: String(1_700_000_000 + NOUNS_CANDIDATE_START_BLOCK + 1), updateMessage: 'latest edit',
  });
  assert.equal(raw.contractAddress, NOUNS_DAO_DATA_PROXY);
  assert.equal(raw.blockNumber, String(SNAPSHOT));
  assert.equal(raw.blockHash, BLOCK_HASH);
  assert.equal(raw.transactionHash, TX2);
  assert.equal(raw.logIndex, 0);
  assert.equal(raw.sourceKind, 'nouns-candidate-logs');
  assert.deepEqual(records.snapshot, { blockNumber: SNAPSHOT, blockHash: BLOCK_HASH });
  assert.deepEqual(blockCalls.sort((a, b) => a - b), [NOUNS_CANDIDATE_START_BLOCK + 1, SNAPSHOT]);
  assert.deepEqual(calls.slice(0, 2), [['send', 'eth_chainId'], ['getBlock', SNAPSHOT]], 'chain and pinned hash are checked before logs');
  const filters = calls.filter(([kind]) => kind === 'getLogs').map(([, filter]) => filter);
  assert.equal(filters[0].address, NOUNS_DAO_DATA_PROXY);
  assert.equal(filters[0].fromBlock, NOUNS_CANDIDATE_START_BLOCK);
  assert.equal(filters[0].toBlock, SNAPSHOT);
  assert.equal(getAddress(filters[1].address), getAddress(DAO_CONFIGS.nouns.currentGovernor));
});

test('updates close independently, cancellation wins by canonical log order, and empty slugs are retained', async () => {
  const updateOnly = candidateEvent('ProposalCandidateCreated', { slug: 'update-only', proposalIdToUpdate: 99n });
  const empty = candidateEvent('ProposalCandidateCreated', { slug: '', blockNumber: NOUNS_CANDIDATE_START_BLOCK + 1, transactionHash: TX2 });
  const cancel = canceledEvent('', { blockNumber: NOUNS_CANDIDATE_START_BLOCK + 2 });
  const { source } = sourceFor({ candidateLogs: [cancel, updateOnly, empty] });
  const records = await source.fetchCandidates(SNAPSHOT);
  const bySlug = new Map(records.map((record) => [record.target.slug, record.target]));
  assert.equal(bySlug.get('update-only').eligibility, 'CLOSED');
  assert.equal(bySlug.get('').eligibility, 'CLOSED');
  assert.equal(bySlug.get('').nativeState, 'CANCELED');
  assert.equal(bySlug.get('').targetId, `candidate:${PROPOSER}:${keccak256(toUtf8Bytes(''))}`);
});

test('cancellation remains sticky across later canonical updates', async () => {
  const created = candidateEvent('ProposalCandidateCreated', { slug: 'sticky' });
  const canceled = canceledEvent('sticky', { blockNumber: NOUNS_CANDIDATE_START_BLOCK + 1 });
  const updated = candidateEvent('ProposalCandidateUpdated', {
    slug: 'sticky', blockNumber: NOUNS_CANDIDATE_START_BLOCK + 2, transactionHash: TX2,
    description: '# Updated after cancellation',
  });
  const { source } = sourceFor({ candidateLogs: [updated, canceled, created] });
  const [record] = await source.fetchCandidates(SNAPSHOT);
  assert.equal(record.target.nativeState, 'CANCELED');
  assert.equal(record.target.eligibility, 'CLOSED');
  assert.equal(record.target.description, '# Updated after cancellation');
});

test('official title derivation removes hash separators and falls back to Untitled', async () => {
  const withHashes = candidateEvent('ProposalCandidateCreated', { slug: 'hashes', description: 'prefix# First # Second\nBody' });
  const untitled = candidateEvent('ProposalCandidateCreated', { slug: 'untitled', description: '   ', index: 1 });
  const { source } = sourceFor({ candidateLogs: [untitled, withHashes] });
  const records = await source.fetchCandidates(SNAPSHOT);
  const titles = new Map(records.map(({ target }) => [target.slug, target.title]));
  assert.equal(titles.get('hashes'), 'First  Second');
  assert.equal(titles.get('untitled'), 'Untitled');
});

test('candidate reconstruction requires a provider and fails closed on malformed logs or missing pinned provenance', async () => {
  const withoutProvider = new NounsSubgraphSource({ fetch: async () => { throw new Error('unused'); } });
  await assert.rejects(withoutProvider.fetchCandidates(SNAPSHOT), /provider is required/i);

  const malformed = { ...candidateEvent('ProposalCandidateCreated'), data: '0x1234' };
  await assert.rejects(sourceFor({ candidateLogs: [malformed] }).source.fetchCandidates(SNAPSHOT), /candidate log is malformed/i);
  const forgedHash = candidateEvent('ProposalCandidateCreated', { encodedProposalHash: `0x${'99'.repeat(32)}` });
  await assert.rejects(sourceFor({ candidateLogs: [forgedHash] }).source.fetchCandidates(SNAPSHOT), /encoded hash does not match/i);
  await assert.rejects(sourceFor({ blockHash: null }).source.fetchCandidates(SNAPSHOT), /block provenance is unavailable/i);
});

test('candidate reconstruction rejects non-mainnet before pinned block and log reads', async () => {
  const { source, calls } = sourceFor({ chainId: '0x89' });
  await assert.rejects(source.fetchCandidates(SNAPSHOT), /not mainnet/i);
  assert.deepEqual(calls, [['send', 'eth_chainId']]);
});

test('empty candidate enumerations retain independently verified snapshot metadata', async () => {
  const { source } = sourceFor();
  const records = await source.fetchCandidates(SNAPSHOT);
  assert.equal(records.length, 0);
  assert.deepEqual(records.snapshot, { blockNumber: SNAPSHOT, blockHash: BLOCK_HASH });
});

test('candidate reconstruction caches finalized history and scans only new blocks', async () => {
  const created = candidateEvent('ProposalCandidateCreated');
  const { source, calls, blockCalls } = sourceFor({ candidateLogs: [created] });
  assert.equal((await source.fetchCandidates(SNAPSHOT)).length, 1);
  calls.length = 0; blockCalls.length = 0;
  const next = await source.fetchCandidates(SNAPSHOT + 1);
  assert.equal(next.length, 1);
  assert.deepEqual(next.snapshot, { blockNumber: SNAPSHOT + 1, blockHash: BLOCK_HASH });
  const filters = calls.filter(([kind]) => kind === 'getLogs').map(([, filter]) => filter);
  assert.deepEqual(filters.map((filter) => [filter.fromBlock, filter.toBlock]), [
    [SNAPSHOT + 1, SNAPSHOT + 1], [SNAPSHOT + 1, SNAPSHOT + 1],
  ]);
  assert.deepEqual(blockCalls, [SNAPSHOT + 1, SNAPSHOT]);
});

test('candidate cache rebuilds on a same-height canonical hash replacement', async () => {
  const candidateLogs = [candidateEvent('ProposalCandidateCreated')];
  let canonicalHash = BLOCK_HASH;
  const { source, calls } = sourceFor({ candidateLogs, blockHash: () => canonicalHash });
  assert.equal((await source.fetchCandidates(SNAPSHOT)).length, 1);

  candidateLogs.length = 0;
  canonicalHash = `0x${'12'.repeat(32)}`;
  calls.length = 0;
  const rebuilt = await source.fetchCandidates(SNAPSHOT);

  assert.equal(rebuilt.length, 0);
  assert.deepEqual(rebuilt.snapshot, { blockNumber: SNAPSHOT, blockHash: canonicalHash });
  const filters = calls.filter(([kind]) => kind === 'getLogs').map(([, filter]) => filter);
  assert.deepEqual(filters.map((filter) => [filter.fromBlock, filter.toBlock]), [
    [NOUNS_CANDIDATE_START_BLOCK, SNAPSHOT], [NOUNS_CANDIDATE_START_BLOCK, SNAPSHOT],
  ]);
});

test('candidate cache validates its finalized ancestor before a higher-snapshot reuse', async () => {
  const candidateLogs = [candidateEvent('ProposalCandidateCreated')];
  let reorged = false;
  const replacementAncestorHash = `0x${'34'.repeat(32)}`;
  const nextHash = `0x${'56'.repeat(32)}`;
  const { source, calls } = sourceFor({
    candidateLogs,
    blockHash: (number) => {
      if (!reorged) return BLOCK_HASH;
      return number === SNAPSHOT ? replacementAncestorHash : nextHash;
    },
  });
  assert.equal((await source.fetchCandidates(SNAPSHOT)).length, 1);

  candidateLogs.length = 0;
  reorged = true;
  calls.length = 0;
  const rebuilt = await source.fetchCandidates(SNAPSHOT + 1);

  assert.equal(rebuilt.length, 0);
  assert.deepEqual(rebuilt.snapshot, { blockNumber: SNAPSHOT + 1, blockHash: nextHash });
  const filters = calls.filter(([kind]) => kind === 'getLogs').map(([, filter]) => filter);
  assert.deepEqual(filters.map((filter) => [filter.fromBlock, filter.toBlock]), [
    [NOUNS_CANDIDATE_START_BLOCK, SNAPSHOT + 1], [NOUNS_CANDIDATE_START_BLOCK, SNAPSHOT + 1],
  ]);
});

function workerSource({ proposalSnapshot, candidateSnapshot }) {
  const proposals = [];
  if (proposalSnapshot) Object.defineProperty(proposals, 'snapshot', { value: proposalSnapshot });
  const candidates = [];
  if (candidateSnapshot) Object.defineProperty(candidates, 'snapshot', { value: candidateSnapshot });
  return {
    id: 'nouns-subgraph', fromBlock: 10, replayBlocks: 0, config: DAO_CONFIGS.nouns,
    rpcUrl: 'https://rpc.example', publicEndpoint: 'https://index.example',
    async head() { return 20; }, async fetchRange() { return []; }, async normalizeLog() { throw new Error('unexpected'); },
    async fetchProposals() { return proposals; }, async fetchCandidates() { return candidates; },
  };
}

test('worker requires both proposal and candidate snapshot metadata when both canonical target enumerations exist', async () => {
  const snapshot = { blockNumber: 20, blockHash: BLOCK_HASH };
  for (const source of [
    workerSource({ candidateSnapshot: snapshot }),
    workerSource({ proposalSnapshot: snapshot }),
  ]) {
    const worker = new GovernanceSyncWorker({ store: new MemoryGovernanceStore(), sources: { nouns: source }, batchSize: 100 });
    await assert.rejects(worker.syncDao('nouns'), /snapshot metadata is required/i);
  }
});
