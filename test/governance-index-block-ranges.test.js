const assert = require("node:assert/strict");
const test = require("node:test");
const { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } = require("ethers");

const {
  DAO_CONFIGS,
  MemoryGovernanceStore,
  GovernanceSyncWorker,
  EnsGovernorSource,
} = require("../src");
const {
  DEFAULT_LOG_BLOCK_BATCH_SIZE,
  blockRanges,
  parseBlockBatchSize,
  resolveLogBlockBatchSize,
} = require("../src/domain/block-range");

const ADDRESS = getAddress("0x0000000000000000000000000000000000000001");
const OTHER = getAddress("0x0000000000000000000000000000000000000002");
const TX = `0x${"ab".repeat(32)}`;
const ENS_FROM_BLOCK = DAO_CONFIGS.ens.fromBlock;
// The free dRPC plan the repository defaults to rejects anything wider.
const PROVIDER_LIMIT = 10_000;

const ENS_IFACE = new Interface([
  "event ProposalCreated(uint256 proposalId,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
]);

function proposalLog(blockNumber) {
  const targets = [OTHER]; const values = [0n]; const signatures = [""]; const calldatas = ["0x1234"];
  const description = "# Range fixture\nBody";
  const proposalId = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address[]", "uint256[]", "bytes[]", "bytes32"], [targets, values, calldatas, keccak256(toUtf8Bytes(description))],
  ))).toString();
  const encoded = ENS_IFACE.encodeEventLog(ENS_IFACE.getEvent("ProposalCreated"), [proposalId, ADDRESS, targets, values, signatures, calldatas, 0n, 0n, description]);
  return { proposalId, log: { address: DAO_CONFIGS.ens.contractAddress, blockNumber, transactionHash: TX, index: 0, topics: encoded.topics, data: encoded.data } };
}

const governor = {
  async state() { return 4; },
  async proposalSnapshot() { return 0n; },
  async proposalDeadline() { return 0n; },
  async proposalVotes() { return [0n, 0n, 0n]; },
  async quorum() { return 1n; },
};

// A provider that behaves like a hosted free-plan endpoint: any eth_getLogs span
// wider than PROVIDER_LIMIT blocks is rejected outright.
function boundedProvider({ head, logs = [], limit = PROVIDER_LIMIT }) {
  const calls = [];
  return {
    calls,
    async getBlockNumber() { return head; },
    async getBlock(blockNumber) { return { timestamp: 1_700_000_000 + Number(blockNumber) }; },
    async getLogs(filter) {
      const span = Number(filter.toBlock) - Number(filter.fromBlock) + 1;
      calls.push({ fromBlock: Number(filter.fromBlock), toBlock: Number(filter.toBlock), span, topics: filter.topics });
      if (span > limit) throw new Error(`eth_getLogs range of ${span} blocks exceeds the ${limit} block limit`);
      return logs.filter((entry) => entry.blockNumber >= Number(filter.fromBlock) && entry.blockNumber <= Number(filter.toBlock));
    },
  };
}

function discoveryCalls(provider) {
  // Proposal discovery filters on the single ProposalCreated topic; the worker's
  // range replay passes an array of topics.
  return provider.calls.filter((call) => typeof call.topics?.[0] === "string");
}

test("block batch size resolves by ENS override, then the generic setting, then the safe default", () => {
  assert.equal(DEFAULT_LOG_BLOCK_BATCH_SIZE, 5000);
  assert.equal(resolveLogBlockBatchSize({ names: ["ENS_PROPOSAL_BLOCK_BATCH_SIZE", "INDEXER_BLOCK_BATCH_SIZE"], env: {} }), 5000);
  assert.equal(resolveLogBlockBatchSize({
    names: ["ENS_PROPOSAL_BLOCK_BATCH_SIZE", "INDEXER_BLOCK_BATCH_SIZE"],
    env: { INDEXER_BLOCK_BATCH_SIZE: "9000" },
  }), 9000);
  assert.equal(resolveLogBlockBatchSize({
    names: ["ENS_PROPOSAL_BLOCK_BATCH_SIZE", "INDEXER_BLOCK_BATCH_SIZE"],
    env: { ENS_PROPOSAL_BLOCK_BATCH_SIZE: "2500", INDEXER_BLOCK_BATCH_SIZE: "9000" },
  }), 2500);
  // An empty variable is unset, and an explicit option outranks the environment.
  assert.equal(resolveLogBlockBatchSize({
    names: ["ENS_PROPOSAL_BLOCK_BATCH_SIZE", "INDEXER_BLOCK_BATCH_SIZE"],
    env: { ENS_PROPOSAL_BLOCK_BATCH_SIZE: "  ", INDEXER_BLOCK_BATCH_SIZE: "9000" },
  }), 9000);
  assert.equal(resolveLogBlockBatchSize({ explicit: 750, names: ["INDEXER_BLOCK_BATCH_SIZE"], env: { INDEXER_BLOCK_BATCH_SIZE: "9000" } }), 750);
});

test("invalid block batch configuration fails clearly and never falls through", () => {
  for (const bad of ["0", "-1", "1.5", "5e3", "20_000", "abc"]) {
    assert.throws(
      () => resolveLogBlockBatchSize({ names: ["ENS_PROPOSAL_BLOCK_BATCH_SIZE", "INDEXER_BLOCK_BATCH_SIZE"], env: { ENS_PROPOSAL_BLOCK_BATCH_SIZE: bad, INDEXER_BLOCK_BATCH_SIZE: "5000" } }),
      /ENS_PROPOSAL_BLOCK_BATCH_SIZE must be a positive integer number of blocks/,
      `expected ${bad} to be rejected`,
    );
  }
  assert.throws(
    () => resolveLogBlockBatchSize({ names: ["INDEXER_BLOCK_BATCH_SIZE"], env: { INDEXER_BLOCK_BATCH_SIZE: "nope" } }),
    /INDEXER_BLOCK_BATCH_SIZE must be a positive integer/,
  );
  assert.throws(() => new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider: {}, governor, proposalBatchSize: 0 }), /proposalBatchSize must be a positive integer/);
  assert.throws(
    () => new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider: {}, governor, env: { ENS_PROPOSAL_BLOCK_BATCH_SIZE: "0" } }),
    /ENS_PROPOSAL_BLOCK_BATCH_SIZE must be a positive integer/,
  );
  assert.throws(() => new GovernanceSyncWorker({ store: new MemoryGovernanceStore(), sources: {}, batchSize: "lots" }), /batchSize must be a positive integer/);
  assert.equal(parseBlockBatchSize("5000", "x"), 5000);
});

test("blockRanges never emits a span wider than the batch size and stops at the head", () => {
  const ranges = [...blockRanges(100, 349, 100)];
  assert.deepEqual(ranges, [
    { fromBlock: 100, toBlock: 199 },
    { fromBlock: 200, toBlock: 299 },
    { fromBlock: 300, toBlock: 349 },
  ]);
  assert.deepEqual([...blockRanges(10, 9, 100)], []);
});

test("ENS backfill against a provider that rejects ranges over 10000 blocks succeeds on the default", async () => {
  const head = ENS_FROM_BLOCK + 42_000;
  const fixture = proposalLog(ENS_FROM_BLOCK + 21_000);
  const provider = boundedProvider({ head, logs: [fixture.log] });
  const store = new MemoryGovernanceStore();
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider, governor, finalityDepth: 0, env: {} });
  assert.equal(source.proposalBatchSize, DEFAULT_LOG_BLOCK_BATCH_SIZE);

  const result = await new GovernanceSyncWorker({ store, sources: { ens: source } }).syncDao("ens");

  assert.equal(result.ok, true);
  assert.equal(result.fullProposalScan, true);
  assert.equal(store.proposals.length, 1);
  assert.equal(store.proposals[0].proposalId, fixture.proposalId);
  // Every request the provider saw — discovery and range replay alike — is inside
  // the provider's limit, and the default span is the conservative 5000.
  assert.ok(provider.calls.length > 0);
  for (const call of provider.calls) assert.ok(call.span <= PROVIDER_LIMIT, `span ${call.span} exceeded the provider limit`);
  const discovery = discoveryCalls(provider);
  assert.equal(discovery[0].fromBlock, ENS_FROM_BLOCK);
  assert.equal(discovery[0].span, DEFAULT_LOG_BLOCK_BATCH_SIZE);
  assert.equal(discovery.length, Math.ceil(42_001 / DEFAULT_LOG_BLOCK_BATCH_SIZE));
  assert.equal(discovery[discovery.length - 1].toBlock, head);
});

test("a hard-coded 20000 block range would have been rejected by the same provider", async () => {
  const head = ENS_FROM_BLOCK + 42_000;
  const provider = boundedProvider({ head, logs: [] });
  const store = new MemoryGovernanceStore();
  // The previous hard-coded value, expressed explicitly. It must fail loudly so a
  // regression back to a wide fixed range cannot pass unnoticed.
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider, governor, finalityDepth: 0, proposalBatchSize: 20_000, env: {} });
  await assert.rejects(
    new GovernanceSyncWorker({ store, sources: { ens: source } }).syncDao("ens"),
    /exceeds the 10000 block limit/,
  );
  // The failed pass leaves a checkpoint carrying the error and does not advance.
  assert.match(store.checkpoints.get("ens:governor-logs").lastError, /exceeds the 10000 block limit/);
});

test("configured batch sizes control ENS proposal log ranges", async () => {
  for (const [env, expected] of [
    [{ ENS_PROPOSAL_BLOCK_BATCH_SIZE: "2500", INDEXER_BLOCK_BATCH_SIZE: "9000" }, 2500],
    [{ INDEXER_BLOCK_BATCH_SIZE: "9000" }, 9000],
    [{}, DEFAULT_LOG_BLOCK_BATCH_SIZE],
  ]) {
    const head = ENS_FROM_BLOCK + 30_000;
    const provider = boundedProvider({ head, logs: [] });
    const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider, governor, finalityDepth: 0, env });
    assert.equal(source.proposalBatchSize, expected);
    await new GovernanceSyncWorker({ store: new MemoryGovernanceStore(), sources: { ens: source }, batchSize: expected }).syncDao("ens");
    const discovery = discoveryCalls(provider);
    assert.equal(discovery.length, Math.ceil(30_001 / expected));
    for (const call of discovery.slice(0, -1)) assert.equal(call.span, expected);
    assert.equal(discovery[discovery.length - 1].toBlock, head);
  }
});

test("incremental sync stays checkpoint-based and never rescans Governor history", async () => {
  const head = ENS_FROM_BLOCK + 30_000;
  const fixture = proposalLog(ENS_FROM_BLOCK + 12_000);
  const provider = boundedProvider({ head, logs: [fixture.log] });
  const store = new MemoryGovernanceStore();
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider, governor, finalityDepth: 0, replayBlocks: 64, env: {} });
  const worker = new GovernanceSyncWorker({ store, sources: { ens: source } });

  await worker.syncDao("ens");
  const checkpoint = store.checkpoints.get("ens:governor-logs");
  assert.equal(Number(checkpoint.nextBlock), head + 1);
  const backfillCalls = provider.calls.length;
  provider.calls.length = 0;

  // Second pass, same head, no full scan requested: discovery must resume from the
  // checkpoint minus the trailing replay, not from the Governor-era lower bound.
  const incremental = await worker.syncDao("ens", { fullProposalScan: false });
  assert.equal(incremental.fullProposalScan, false);
  assert.equal(incremental.fromBlock, head - 64);
  const discovery = discoveryCalls(provider);
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].fromBlock, head - 64);
  assert.equal(discovery[0].toBlock, head);
  assert.ok(provider.calls.length < backfillCalls);
  // Idempotent: the replay re-ingests nothing and the proposal is not duplicated.
  assert.equal(store.proposals.length, 1);
  assert.equal(store.rawRecords.length, 1);
  assert.equal(Number(store.checkpoints.get("ens:governor-logs").nextBlock), head + 1);
});
