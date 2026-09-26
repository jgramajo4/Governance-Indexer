const { Contract, Interface, AbiCoder, getAddress, keccak256, toUtf8Bytes } = require("ethers");
const { DAO_CONFIGS } = require("./config");
const { proposalContentHash } = require("./hash");
const { blockRanges, resolveLogBlockBatchSize } = require("./domain/block-range");
const { TrackingState, isTerminalStatus } = require("./domain/lifecycle");

const ENS_ABI = [
  "event ProposalCreated(uint256 proposalId,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
  "event VoteCast(address indexed voter,uint256 proposalId,uint8 support,uint256 weight,string reason)",
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function proposalDeadline(uint256 proposalId) view returns (uint256)",
  "function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes,uint256 forVotes,uint256 abstainVotes)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
];
const RAILGUN_ABI = ["event VoteCast(uint256 indexed id,address indexed voter,bool affirmative,uint256 votes)"];
const ENS_IFACE = new Interface(ENS_ABI); const RAILGUN_IFACE = new Interface(RAILGUN_ABI);
const SUPPORT = ["AGAINST", "FOR", "ABSTAIN"];
const ENS_STATES = ["PENDING", "ACTIVE", "CANCELLED", "DEFEATED", "SUCCEEDED", "QUEUED", "EXPIRED", "EXECUTED"];
// Refresh eligibility is Gavel's tracking state, not the raw source value: a
// source that never advances past ACTIVE must not pin a finished proposal in the
// refresh set. The worker has already planned the set, so a row that reaches
// here is one the planner still wants observed; this is a defensive second look
// for a store or caller that supplied its own context.
function isTerminalRow(row) {
  if (row?.trackingState) return row.trackingState === TrackingState.FINAL;
  const derived = row?.effectiveStatus ?? row?.normalized?.effectiveStatus ?? row?.normalized?.outcome;
  if (derived) return isTerminalStatus(derived);
  // Nothing classified this row, so a caller supplied its own context. The raw
  // source state is all that is left and it is consulted last, never first: a
  // stale non-terminal value costs one refresh, which is the safe direction.
  return isTerminalStatus(row?.normalized?.state);
}
function timestamp(block) { return new Date(Number(block.timestamp) * 1000).toISOString(); }
function raw(config, log, head, kind, endpoint) { return { daoId: config.id, sourceId: config.source.id, chainId: config.chainId, contractAddress: getAddress(log.address), transactionHash: log.transactionHash, logIndex: Number(log.index ?? log.logIndex), blockNumber: String(log.blockNumber), blockHash: log.blockHash || null, recordType: kind, payload: { topics: log.topics, data: log.data }, sourceKind: config.source.kind, sourceEndpoint: endpoint, observedHead: String(head) }; }

class BlockRangeSource {
  constructor(config, options = {}) { this.config = config; this.id = config.source.id; this.rpcUrl = options.rpcUrl; this.provider = options.provider; this.fromBlock = Number(options.fromBlock ?? config.fromBlock); this.finalityDepth = Number(options.finalityDepth ?? 12); this.replayBlocks = Number(options.replayBlocks ?? 64); if (!this.rpcUrl || !/^https?:\/\//.test(this.rpcUrl)) throw new TypeError("rpcUrl must be an HTTP(S) URL for accurate provenance"); this.publicEndpoint = options.sourcePublicEndpoint || process.env.PUBLIC_SOURCE_ENDPOINT || new URL(this.rpcUrl).origin; if (!/^https?:\/\//.test(this.publicEndpoint)) throw new TypeError("sourcePublicEndpoint must be an HTTP(S) URL"); if (!this.provider) throw new TypeError("provider is required"); if (!Number.isSafeInteger(this.fromBlock) || this.fromBlock <= 0) throw new RangeError(`${config.id} requires an explicit positive fromBlock`); }
  async head() { return Number(await this.provider.getBlockNumber()) - this.finalityDepth; }
  // The caller owns the span: the sync worker never asks for more than its
  // configured block batch size, so this stays a single provider request.
  async fetchRange(fromBlock, toBlock) { if (toBlock < fromBlock) return []; return this.provider.getLogs({ address: this.config.contractAddress, fromBlock, toBlock, topics: [this.topics] }); }
}
class EnsGovernorSource extends BlockRangeSource {
  constructor(options = {}) { super(DAO_CONFIGS.ens, { rpcUrl: options.rpcUrl || process.env.ETHEREUM_RPC_URL, ...options }); this.topics = [ENS_IFACE.getEvent("ProposalCreated").topicHash, ENS_IFACE.getEvent("VoteCast").topicHash]; this.governor = options.governor || new Contract(this.config.contractAddress, ENS_ABI, this.provider); this.proposalBatchSize = resolveLogBlockBatchSize({ explicit: options.proposalBatchSize, explicitName: "proposalBatchSize", names: ["ENS_PROPOSAL_BLOCK_BATCH_SIZE", "INDEXER_BLOCK_BATCH_SIZE"], env: options.env }); }
  async refreshProposal(record, head) {
    const id = record.proposal.proposalId;
    const overrides = { blockTag: head };
    const [stateRaw, snapshotRaw, deadlineRaw, votesRaw] = await Promise.all([
      this.governor.state(id, overrides),
      this.governor.proposalSnapshot(id, overrides),
      this.governor.proposalDeadline(id, overrides),
      this.governor.proposalVotes(id, overrides),
    ]);
    const snapshot = snapshotRaw.toString();
    const quorum = await this.governor.quorum(snapshot, overrides);
    const normalized = {
      ...record.proposal.normalized,
      state: ENS_STATES[Number(stateRaw)] || `UNKNOWN_${Number(stateRaw)}`,
      outcome: ENS_STATES[Number(stateRaw)] || `UNKNOWN_${Number(stateRaw)}`,
      startBlock: snapshot,
      endBlock: deadlineRaw.toString(),
      againstVotes: (votesRaw.againstVotes ?? votesRaw[0]).toString(),
      forVotes: (votesRaw.forVotes ?? votesRaw[1]).toString(),
      abstainVotes: (votesRaw.abstainVotes ?? votesRaw[2]).toString(),
      quorumVotes: quorum.toString(),
    };
    return { ...record, proposal: { ...record.proposal, normalized } };
  }
  // Discovery is scoped to the requested range unless a full enumeration was
  // asked for. Mutable state for proposals created earlier is refreshed from
  // the indexed rows the worker supplies, so a steady-state sync never rescans
  // Governor history. Either way the window is walked in `proposalBatchSize`
  // spans so no single `eth_getLogs` exceeds what the provider allows.
  async fetchProposals(fromBlock, toBlock, head, context = {}) {
    const proposalTopic = ENS_IFACE.getEvent("ProposalCreated").topicHash;
    const scanFrom = context.full ? this.fromBlock : Math.max(this.fromBlock, Number(fromBlock));
    const scanTo = Math.min(Number(head), context.full ? Number(head) : Number(toBlock));
    const logs = [];
    for (const range of blockRanges(scanFrom, scanTo, this.proposalBatchSize)) {
      logs.push(...await this.provider.getLogs({ address: this.config.contractAddress, fromBlock: range.fromBlock, toBlock: range.toBlock, topics: [proposalTopic] }));
    }
    const records = [];
    const discovered = new Set();
    for (const log of logs.filter((entry) => entry.topics?.[0] === proposalTopic)) {
      const record = await this.normalizeLog(log, head);
      discovered.add(String(record.proposal.proposalId));
      records.push(await this.refreshProposal(record, head));
    }
    for (const row of context.refreshProposals || []) {
      const proposalId = String(row.proposalId);
      if (discovered.has(proposalId) || isTerminalRow(row)) continue;
      records.push(await this.refreshProposal({
        proposal: { daoId: "ens", proposalId, contentHash: row.contentHash, normalized: row.normalized, actions: row.normalized?.actions },
      }, head));
    }
    return records;
  }
  async normalizeLog(log, head) {
    const parsed = ENS_IFACE.parseLog(log); const block = await this.provider.getBlock(log.blockNumber); if (!block) throw new Error(`missing block ${log.blockNumber}`);
    if (parsed.name === "ProposalCreated") {
      const a = parsed.args; const id = a.proposalId.toString(); const targets = Array.from(a.targets).map(getAddress); const values = Array.from(a[3]).map(String); const signatures = Array.from(a.signatures).map(String); const calldatas = Array.from(a.calldatas).map((x) => String(x).toLowerCase());
      if (![targets.length, values.length, signatures.length, calldatas.length].every((n) => n === targets.length)) throw new Error(`ENS proposal ${id} has misaligned action arrays`);
      const calculated = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["address[]","uint256[]","bytes[]","bytes32"], [targets, values, calldatas.map((data,i) => signatures[i] ? `${keccak256(toUtf8Bytes(signatures[i])).slice(0,10)}${data.slice(2)}` : data), keccak256(toUtf8Bytes(a.description))]))).toString();
      if (calculated !== id) throw new Error(`ENS proposal hash mismatch: event ${id}, calculated ${calculated}`);
      const actions = targets.map((target,index) => ({ index, target, valueWei: values[index], signature: signatures[index], calldata: calldatas[index] }));
      const normalized = { id, contentHash: proposalContentHash({ description: a.description, targets, values, signatures, calldatas }), title: String(a.description).match(/^#\s+(.+)$/m)?.[1] || "", description: String(a.description), proposer: getAddress(a.proposer), state: "UNKNOWN", outcome: "UNKNOWN", createdBlock: String(log.blockNumber), createdAt: timestamp(block), startBlock: a.startBlock.toString(), endBlock: a.endBlock.toString(), quorumVotes: "0", forVotes: "0", againstVotes: "0", abstainVotes: "0", actions, dao: "ens", chainId: 1, venue: "governor", timing: "block" };
      const rawRecord = raw(this.config, log, head, "proposal", this.rpcUrl); rawRecord.sourcePublicEndpoint = this.publicEndpoint; rawRecord.proposalId = id;
      return { raw: rawRecord, proposal: { daoId: "ens", proposalId: id, contentHash: normalized.contentHash, normalized, actions } };
    }
    const a = parsed.args; const code = Number(a.support); if (!SUPPORT[code]) throw new Error(`Unknown ENS support ${code}`);
    const proposalId = a.proposalId.toString(); const rawRecord = raw(this.config, log, head, "vote", this.rpcUrl); rawRecord.sourcePublicEndpoint = this.publicEndpoint; rawRecord.proposalId = proposalId;
    return { raw: rawRecord, vote: { daoId: "ens", chainId: 1, contractAddress: this.config.contractAddress, proposalId, voter: getAddress(a.voter), support: SUPPORT[code], reason: a.reason === "" ? null : String(a.reason), voteWeight: a.weight.toString(), blockNumber: String(log.blockNumber), timestamp: timestamp(block), transactionHash: log.transactionHash, logIndex: Number(log.index ?? log.logIndex), sourceKind: this.config.source.kind, sourceEndpoint: this.rpcUrl, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head) } };
  }
}
// Railgun needs no batch setting of its own. Its only log query is the inherited
// `fetchRange`, which the sync worker already bounds by INDEXER_BLOCK_BATCH_SIZE,
// and proposal enumeration walks `proposalsLength` through contract view calls
// rather than logs, so it carries no block range at all.
class RailgunVotingSource extends BlockRangeSource {
  constructor(options = {}) { super(DAO_CONFIGS["railgun-eth"], { rpcUrl: options.rpcUrl || process.env.ETHEREUM_RPC_URL, ...options }); this.topics = RAILGUN_IFACE.getEvent("VoteCast").topicHash; this.proposalLoader = options.proposalLoader; this.proposalCountLoader = options.proposalCountLoader; }
  async loadProposal(id, head) { if (!this.proposalLoader) return null; const normalized = await this.proposalLoader(String(id), head); return { daoId: "railgun-eth", proposalId: String(id), contentHash: normalized.contentHash, normalized, actions: normalized.actions }; }
  async fetchProposals(_fromBlock, _toBlock, head, context = {}) {
    if (!this.proposalCountLoader || !this.proposalLoader) return [];
    const count = Number(await this.proposalCountLoader(head)); if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid Railgun proposalsLength");
    const records = [];
    // Only ids past the highest indexed proposal are new. Older proposals are
    // re-read only while their state can still change.
    const firstNewId = context.full ? 0 : Math.max(0, Number(context.maxProposalId ?? -1) + 1);
    if (!context.full) {
      for (const row of context.refreshProposals || []) {
        const proposalId = String(row.proposalId);
        if (Number(proposalId) >= firstNewId || isTerminalRow(row)) continue;
        records.push({ proposal: await this.loadProposal(proposalId, head) });
      }
    }
    for (let id = firstNewId; id < count; id++) {
      const proposal = await this.loadProposal(id, head);
      records.push({ raw: { daoId: "railgun-eth", sourceId: this.id, sourceRecordKey: `proposal:${id}`, externalId: String(id), chainId: 1, contractAddress: this.config.contractAddress, transactionHash: null, logIndex: null, blockNumber: String(this.fromBlock), blockHash: null, recordType: "proposal", proposalId: String(id), contentHash: proposal.contentHash, payload: { id: String(id), contentHash: proposal.contentHash }, sourceKind: this.config.source.kind, sourceEndpoint: this.rpcUrl, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head) }, proposal });
    }
    return records;
  }
  async normalizeLog(log, head) { const parsed = RAILGUN_IFACE.parseLog(log); const block = await this.provider.getBlock(log.blockNumber); if (!block) throw new Error(`missing block ${log.blockNumber}`); const a = parsed.args; const id=a.id.toString(); const proposal = await this.loadProposal(id, head); const rawRecord = raw(this.config, log, head, "vote", this.rpcUrl); rawRecord.sourcePublicEndpoint = this.publicEndpoint; rawRecord.proposalId = id; return { raw: rawRecord, proposal, vote: { daoId: "railgun-eth", chainId: 1, contractAddress: this.config.contractAddress, proposalId: id, voter: getAddress(a.voter), support: a.affirmative ? "FOR" : "AGAINST", reason: null, voteWeight: a.votes.toString(), blockNumber: String(log.blockNumber), timestamp: timestamp(block), transactionHash: log.transactionHash, logIndex: Number(log.index ?? log.logIndex), sourceKind: this.config.source.kind, sourceEndpoint: this.rpcUrl, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head) } }; }
}
module.exports = { ENS_ABI, RAILGUN_ABI, BlockRangeSource, EnsGovernorSource, RailgunVotingSource, isTerminalRow };
