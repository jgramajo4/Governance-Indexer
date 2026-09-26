const { createHash } = require("node:crypto");
const {
  AbiCoder,
  Interface,
  concat,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} = require("ethers");
const { DAO_CONFIGS } = require("./config");
const { normalizeVote, normalizeProposal } = require("./domain/nouns-history");
const { candidateTargetId, adaptNounsCandidateLifecycle } = require("./domain/nouns-candidate");
const { canonicalGateActions } = require("./gate-action");
const { isTerminalRow } = require("./sources");

const PROPOSAL_FIELDS = `id title description status proposer { id } targets values signatures calldatas createdTimestamp createdBlock startBlock endBlock quorumVotes forVotes againstVotes abstainVotes`;
const VOTE_FIELDS = `id supportDetailed votesRaw reason blockNumber blockTimestamp transactionHash clientId voter { id } proposal { ${PROPOSAL_FIELDS} }`;
const SNAPSHOT = `query { _meta { block { number } } }`;
const PAGE = `query Votes($first:Int!,$after:ID!,$from:BigInt!,$to:BigInt!,$snapshot:Int!){votes(first:$first,orderBy:id,orderDirection:asc,block:{number:$snapshot},where:{id_gt:$after,blockNumber_gte:$from,blockNumber_lte:$to}){${VOTE_FIELDS}}}`;
const PROPOSALS_PAGE = `query Proposals($first:Int!,$after:ID!,$snapshot:Int!){_meta(block:{number:$snapshot}){block{number hash}} proposals(first:$first,orderBy:id,orderDirection:asc,block:{number:$snapshot},where:{id_gt:$after}){${PROPOSAL_FIELDS}}}`;
// Discovery restricted to proposals created in the synced range, and a targeted
// refresh for proposals whose state can still change. Together these replace the
// full re-enumeration on every cycle.
const NEW_PROPOSALS_PAGE = `query NewProposals($first:Int!,$after:ID!,$from:BigInt!,$snapshot:Int!){_meta(block:{number:$snapshot}){block{number hash}} proposals(first:$first,orderBy:id,orderDirection:asc,block:{number:$snapshot},where:{id_gt:$after,createdBlock_gte:$from}){${PROPOSAL_FIELDS}}}`;
const REFRESH_PROPOSALS = `query RefreshProposals($ids:[ID!]!,$snapshot:Int!){_meta(block:{number:$snapshot}){block{number hash}} proposals(first:1000,where:{id_in:$ids},block:{number:$snapshot}){${PROPOSAL_FIELDS}}}`;
const NOUNS_DAO_DATA_PROXY = "0xf790a5f59678dd733fb3de93493a91f472ca1365";
const NOUNS_CANDIDATE_START_BLOCK = 17812145;
const CANDIDATE_EVENT_ABI = [
  "event ProposalCandidateCreated(address indexed msgSender,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string slug,uint256 proposalIdToUpdate,bytes32 encodedProposalHash)",
  "event ProposalCandidateUpdated(address indexed msgSender,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string slug,uint256 proposalIdToUpdate,bytes32 encodedProposalHash,string reason)",
  "event ProposalCandidateCanceled(address indexed msgSender,string slug)",
];
const PROPOSAL_CREATED_ABI = [
  "event ProposalCreated(uint256 id,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
];
const candidateInterface = new Interface(CANDIDATE_EVENT_ABI);
const proposalInterface = new Interface(PROPOSAL_CREATED_ABI);
const candidateTopics = ["ProposalCandidateCreated", "ProposalCandidateUpdated", "ProposalCandidateCanceled"]
  .map((name) => candidateInterface.getEvent(name).topicHash);
const proposalCreatedTopic = proposalInterface.getEvent("ProposalCreated").topicHash;

function logIndex(log) {
  const value = log.index ?? log.logIndex;
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new TypeError("invalid log index");
  return Number(value);
}

function logOrder(left, right) {
  return Number(left.blockNumber) - Number(right.blockNumber)
    || Number(left.transactionIndex ?? 0) - Number(right.transactionIndex ?? 0)
    || logIndex(left) - logIndex(right);
}

function candidateTitle(description) {
  const parts = description.split("#", 3);
  if (parts.length > 1) parts.shift();
  const firstLine = parts.join("").split("\n", 1)[0].trim().replaceAll("**", "").replaceAll("__", "");
  return firstLine || "Untitled";
}

function packedArrayHash(values, encode) {
  return keccak256(concat(values.map(encode)));
}

function proposalCandidateHash({ proposer, targets, values, signatures, calldatas, description, proposalIdToUpdate = 0n }) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
    [
      proposer,
      packedArrayHash(targets, (value) => zeroPadValue(value, 32)),
      packedArrayHash(values, (value) => zeroPadValue(toBeHex(value), 32)),
      packedArrayHash(signatures, (value) => keccak256(toUtf8Bytes(value))),
      packedArrayHash(calldatas, (value) => keccak256(value)),
      keccak256(toUtf8Bytes(description)),
    ],
  );
  const proposalId = BigInt(proposalIdToUpdate);
  return keccak256(proposalId > 0n ? concat([zeroPadValue(toBeHex(proposalId), 32), encoded]) : encoded).toLowerCase();
}

function parseCanonicalLog(iface, log, label) {
  try {
    if (!Number.isSafeInteger(Number(log?.blockNumber)) || Number(log.blockNumber) < 0
        || typeof log.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) throw new Error();
    logIndex(log);
    const parsed = iface.parseLog(log);
    if (!parsed) throw new Error();
    return parsed;
  } catch (error) {
    throw new Error(`Nouns ${label} log is malformed`, { cause: error });
  }
}

function contentFromCandidateEvent(parsed) {
  const targets = Array.from(parsed.args[1]);
  const values = Array.from(parsed.args[2]);
  const signatures = Array.from(parsed.args[3]);
  const calldatas = Array.from(parsed.args[4]);
  if (targets.length !== values.length || targets.length !== signatures.length || targets.length !== calldatas.length) {
    throw new Error("Nouns Proposal Candidate log is malformed");
  }
  const content = {
    proposer: getAddress(parsed.args[0]).toLowerCase(),
    slug: String(parsed.args[6]),
    targets,
    values,
    signatures,
    calldatas,
    description: String(parsed.args[5]),
    proposalIdToUpdate: parsed.args[7].toString(),
    encodedProposalHash: String(parsed.args[8]).toLowerCase(),
    reason: parsed.name === "ProposalCandidateUpdated" ? String(parsed.args[9]) : "",
  };
  if (proposalCandidateHash(content) !== content.encodedProposalHash) {
    throw new Error("Nouns Proposal Candidate encoded hash does not match canonical content");
  }
  return content;
}

function candidateRecord(state, snapshot, blockHash, matchingProposalIds, timestamp, source) {
  try {
    const content = state.content;
    const actions = canonicalGateActions(content.targets.map((target, actionIndex) => ({
      actionIndex,
      target,
      valueWei: content.values[actionIndex].toString(),
      signature: content.signatures[actionIndex],
      calldata: content.calldatas[actionIndex],
    })), { exact: true });
    const lifecycle = adaptNounsCandidateLifecycle({
      latestVersionValid: true,
      canceled: state.canceled,
      proposalIdToUpdate: content.proposalIdToUpdate,
      matchingProposalIds,
    });
    const targetId = candidateTargetId(content.proposer, content.slug);
    const versionLogIndex = logIndex(state.contentLog);
    const latestLog = state.latestLog;
    const target = {
      dao: "nouns",
      targetId,
      kind: "candidate",
      proposer: content.proposer,
      slug: content.slug,
      title: candidateTitle(content.description),
      description: content.description,
      nativeState: state.canceled ? "CANCELED" : "ACTIVE",
      ...lifecycle,
      matchingProposalIds,
      contentHash: content.encodedProposalHash,
      actions,
      latestVersion: {
        id: `${state.contentLog.transactionHash}-${versionLogIndex}`,
        createdBlock: String(state.contentLog.blockNumber),
        createdTimestamp: String(timestamp),
        updateMessage: content.reason,
      },
    };
    const payload = {
      proposer: content.proposer,
      slug: content.slug,
      canceled: state.canceled,
      createdBlock: String(state.createdBlock),
      lastUpdatedBlock: String(latestLog.blockNumber),
      encodedProposalHash: content.encodedProposalHash,
      proposalIdToUpdate: content.proposalIdToUpdate,
      matchingProposalIds,
      targets: content.targets,
      values: content.values.map(String),
      signatures: content.signatures,
      calldatas: content.calldatas,
      description: content.description,
    };
    return {
      raw: {
        daoId: "nouns", sourceId: source.id, sourceRecordKey: targetId, externalId: targetId,
        chainId: 1, contractAddress: NOUNS_DAO_DATA_PROXY,
        transactionHash: latestLog.transactionHash, logIndex: logIndex(latestLog),
        blockNumber: String(snapshot), blockHash, recordType: "proposal_candidate", proposalId: null,
        contentHash: content.encodedProposalHash.slice(2), payload, sourceKind: "nouns-candidate-logs",
        sourceEndpoint: "ethereum-json-rpc", observedHead: String(snapshot),
      },
      target,
    };
  } catch (error) {
    throw new Error("Nouns Proposal Candidate is malformed", { cause: error });
  }
}

class NounsSubgraphSource {
  constructor(options = {}) {
    this.config = DAO_CONFIGS.nouns; this.id = this.config.source.id;
    this.endpoint = options.endpoint || process.env.NOUNS_SUBGRAPH_URL || this.config.source.endpoint;
    this.publicEndpoint = options.sourcePublicEndpoint || process.env.PUBLIC_SOURCE_ENDPOINT || new URL(this.endpoint).origin;
    this.rpcUrl = this.endpoint; this.fetch = options.fetch || globalThis.fetch; this.provider = options.provider;
    this.fromBlock = Number(options.fromBlock || this.config.fromBlock);
    this.finalityDepth = Number(options.finalityDepth ?? 12); this.replayBlocks = Number(options.replayBlocks ?? 64);
    this.pageSize = Number(options.pageSize || 500); this.timeoutMs = Number(options.timeoutMs || 30_000);
    if (!/^https?:\/\//.test(this.endpoint)) throw new TypeError("NOUNS_SUBGRAPH_URL must be HTTP(S)");
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000) throw new RangeError("pageSize must be an integer from 1 to 1000");
  }
  async request(query, variables = {}) {
    let error;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) throw new Error(`Nouns subgraph HTTP ${response.status}`);
        const body = await response.json(); if (body.errors?.length) throw new Error(JSON.stringify(body.errors)); return body.data;
      } catch (caught) { error = caught; if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1))); }
    }
    throw error;
  }
  async head() {
    const data = await this.request(SNAPSHOT); const head = Number(data?._meta?.block?.number);
    if (!Number.isSafeInteger(head)) throw new Error("Nouns subgraph returned no safe head");
    return Math.max(0, head - this.finalityDepth);
  }
  observeSnapshot(data, snapshot, provenance) {
    const meta = data?._meta?.block;
    const hash = typeof meta?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(meta.hash) ? meta.hash.toLowerCase() : null;
    if (!Number.isSafeInteger(meta?.number) || meta.number !== Number(snapshot)) throw new Error(`Nouns ${snapshot} snapshot metadata missing or mismatched`);
    if (provenance.hash && provenance.hash !== hash) throw new Error(`Nouns ${snapshot} snapshot hash changed during pagination`);
    if (hash) provenance.hash = hash;
  }
  async canonicalSnapshotHash(snapshot, provenance) {
    if (!this.provider) {
      if (!provenance.hash) throw new Error(`Nouns ${snapshot} snapshot hash is unavailable`);
      return provenance.hash;
    }
    const chainIdResult = await Promise.race([
      this.provider.send("eth_chainId", []),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Ethereum chain identity check timed out")), 10_000)),
    ]);
    let chainId;
    try { chainId = BigInt(chainIdResult); } catch { throw new Error("Ethereum chain identity is invalid"); }
    if (chainId !== 1n) throw new Error("Ethereum RPC is not mainnet");
    const block = await this.provider.getBlock(Number(snapshot));
    const hash = typeof block?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(block.hash)
      ? block.hash.toLowerCase() : null;
    if (!hash || Number(block.number) !== Number(snapshot)) throw new Error(`Ethereum ${snapshot} block provenance is unavailable`);
    if (provenance.hash && provenance.hash !== hash) throw new Error(`Nouns ${snapshot} snapshot hash does not match Ethereum`);
    return hash;
  }
  async page(query, field, fromBlock, toBlock, snapshot, provenance) {
    const rows = []; let after = "";
    while (true) {
      const data = await this.request(query, { first: this.pageSize, after, from: String(fromBlock), to: String(toBlock), snapshot: Number(snapshot) });
      if (provenance) this.observeSnapshot(data, snapshot, provenance);
      const page = data?.[field]; if (!Array.isArray(page)) throw new Error(`Nouns subgraph response missing ${field} array`);
      rows.push(...page); if (page.length < this.pageSize) return rows;
      const next = String(page.at(-1).id); if (next <= after) throw new Error(`Nouns ${field} pagination did not advance`); after = next;
    }
  }
  async fetchRange(fromBlock, toBlock, snapshot = toBlock) { return this.page(PAGE, "votes", fromBlock, toBlock, snapshot); }
  async incrementalProposals(fromBlock, snapshot, context, provenance) {
    const rows = await this.page(NEW_PROPOSALS_PAGE, "proposals", fromBlock, snapshot, snapshot, provenance);
    const discovered = new Set(rows.map((row) => String(row.id)));
    const refreshIds = (context.refreshProposals || [])
      .filter((row) => !discovered.has(String(row.proposalId)) && !isTerminalRow(row))
      .map((row) => String(row.proposalId));
    for (let index = 0; index < refreshIds.length; index += 100) {
      const data = await this.request(REFRESH_PROPOSALS, { ids: refreshIds.slice(index, index + 100), snapshot: Number(snapshot) });
      this.observeSnapshot(data, snapshot, provenance);
      const page = data?.proposals;
      if (!Array.isArray(page)) throw new Error("Nouns subgraph response missing proposals array");
      rows.push(...page);
    }
    return rows;
  }

  async fetchProposals(fromBlock, toBlock, snapshot = toBlock, context = {}) {
    const provenance = { hash: null };
    const rows = context.full
      ? await this.page(PROPOSALS_PAGE, "proposals", 0, snapshot, snapshot, provenance)
      : await this.incrementalProposals(fromBlock, snapshot, context, provenance);
    const blockHash = await this.canonicalSnapshotHash(snapshot, provenance);
    const records = rows.map((proposal) => {
      const normalized = { ...normalizeProposal(proposal, { endpoint: this.endpoint, queriedAt: new Date().toISOString(), subgraphBlock: String(snapshot) }), dao: "nouns", chainId: 1, venue: "governor", timing: "block" };
      const payload = { id: proposal.id, title: proposal.title, description: proposal.description, proposer: proposal.proposer, targets: proposal.targets, values: proposal.values, signatures: proposal.signatures, calldatas: proposal.calldatas, createdTimestamp: proposal.createdTimestamp, createdBlock: proposal.createdBlock, startBlock: proposal.startBlock, endBlock: proposal.endBlock };
      return {
        raw: { daoId: "nouns", sourceId: this.id, sourceRecordKey: `proposal:${proposal.id}`, externalId: String(proposal.id), chainId: 1, contractAddress: this.config.contractAddress, transactionHash: null, logIndex: null, blockNumber: String(snapshot), blockHash, recordType: "proposal", proposalId: normalized.id, contentHash: normalized.contentHash, payload, sourceKind: "nouns-subgraph", sourceEndpoint: this.endpoint, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(snapshot) },
        proposal: { daoId: "nouns", proposalId: normalized.id, contentHash: normalized.contentHash, normalized, actions: normalized.actions },
      };
    });
    Object.defineProperty(records, "snapshot", { value: { blockNumber: Number(snapshot), blockHash } });
    return records;
  }
  async fetchCandidates(snapshot) {
    if (!this.provider) throw new Error("Ethereum provider is required for Nouns Proposal Candidates");
    if (!Number.isSafeInteger(Number(snapshot)) || Number(snapshot) < 0) {
      throw new RangeError("candidate snapshot must be a non-negative safe integer");
    }

    // Authenticate the endpoint and pin the finalized block before accepting any
    // event data from it. Candidate rows never cross the subgraph trust boundary.
    const blockHash = await this.canonicalSnapshotHash(snapshot, { hash: null });
    if (Number(snapshot) < NOUNS_CANDIDATE_START_BLOCK) {
      const records = [];
      Object.defineProperty(records, "snapshot", { value: { blockNumber: Number(snapshot), blockHash } });
      return records;
    }
    let cached = this.candidateCache && Number(this.candidateCache.snapshot) <= Number(snapshot)
      && (Number(this.candidateCache.snapshot) !== Number(snapshot) || this.candidateCache.blockHash === blockHash)
      ? this.candidateCache : null;
    if (cached && Number(cached.snapshot) < Number(snapshot)) {
      const ancestor = await this.provider.getBlock(Number(cached.snapshot));
      const ancestorHash = typeof ancestor?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(ancestor.hash)
        ? ancestor.hash.toLowerCase() : null;
      if (!ancestorHash || Number(ancestor.number) !== Number(cached.snapshot)) {
        throw new Error(`Ethereum ${cached.snapshot} block provenance is unavailable`);
      }
      if (ancestorHash !== cached.blockHash) cached = null;
    }
    const scanFrom = cached ? Number(cached.snapshot) + 1 : NOUNS_CANDIDATE_START_BLOCK;
    const [candidateLogs, proposalLogs] = scanFrom > Number(snapshot) ? [[], []] : await Promise.all([
      this.provider.getLogs({
        address: NOUNS_DAO_DATA_PROXY,
        topics: [candidateTopics],
        fromBlock: scanFrom,
        toBlock: Number(snapshot),
      }),
      this.provider.getLogs({
        address: DAO_CONFIGS.nouns.currentGovernor,
        topics: [proposalCreatedTopic],
        fromBlock: scanFrom,
        toBlock: Number(snapshot),
      }),
    ]);
    if (!Array.isArray(candidateLogs) || !Array.isArray(proposalLogs)) throw new Error("Ethereum log response is malformed");

    const states = new Map(cached ? [...cached.states].map(([key, state]) => [key, {
      ...state,
      content: { ...state.content, targets: [...state.content.targets], values: [...state.content.values],
        signatures: [...state.content.signatures], calldatas: [...state.content.calldatas] },
    }]) : []);
    for (const entry of [...candidateLogs].sort(logOrder)) {
      const parsed = parseCanonicalLog(candidateInterface, entry, "Proposal Candidate");
      if (parsed.name === "ProposalCandidateCanceled") {
        const proposer = getAddress(parsed.args[0]).toLowerCase();
        const slug = String(parsed.args[1]);
        const key = candidateTargetId(proposer, slug);
        const state = states.get(key);
        if (!state) throw new Error("Nouns Proposal Candidate cancellation has no canonical candidate");
        state.canceled = true;
        state.latestLog = entry;
        continue;
      }
      const content = contentFromCandidateEvent(parsed);
      const key = candidateTargetId(content.proposer, content.slug);
      const previous = states.get(key);
      if (parsed.name === "ProposalCandidateUpdated" && !previous) {
        throw new Error("Nouns Proposal Candidate update has no canonical candidate");
      }
      states.set(key, {
        content,
        contentLog: entry,
        latestLog: entry,
        createdBlock: previous?.createdBlock ?? entry.blockNumber,
        canceled: previous?.canceled ?? false,
      });
    }

    const proposalIdsByHash = new Map(cached
      ? [...cached.proposalIdsByHash].map(([hash, ids]) => [hash, [...ids]]) : []);
    for (const entry of [...proposalLogs].sort(logOrder)) {
      const parsed = parseCanonicalLog(proposalInterface, entry, "ProposalCreated");
      let hash;
      try {
        hash = proposalCandidateHash({
          proposer: parsed.args[1],
          targets: Array.from(parsed.args[2]),
          values: Array.from(parsed.args[3]),
          signatures: Array.from(parsed.args[4]),
          calldatas: Array.from(parsed.args[5]),
          description: String(parsed.args[8]),
        });
      } catch (error) {
        throw new Error("Nouns ProposalCreated log is malformed", { cause: error });
      }
      const ids = proposalIdsByHash.get(hash) || [];
      ids.push(parsed.args[0].toString());
      proposalIdsByHash.set(hash, ids);
    }

    const eventBlocks = [...new Set([...states.values()].flatMap((state) => [
      Number(state.contentLog.blockNumber),
      Number(state.latestLog.blockNumber),
    ]))];
    const timestamps = new Map(cached?.timestamps || []);
    const missingEventBlocks = eventBlocks.filter((blockNumber) => !timestamps.has(blockNumber));
    const values = await Promise.all(missingEventBlocks.map(async (blockNumber) => {
      const block = await this.provider.getBlock(blockNumber);
      const timestamp = Number(block?.timestamp);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || Number(block?.number) !== blockNumber) {
        throw new Error(`Ethereum ${blockNumber} block timestamp is unavailable`);
      }
      return [blockNumber, timestamp];
    }));
    for (const [blockNumber, timestamp] of values) timestamps.set(blockNumber, timestamp);

    const records = [...states.values()].map((state) => candidateRecord(
      state,
      snapshot,
      blockHash,
      proposalIdsByHash.get(state.content.encodedProposalHash) || [],
      timestamps.get(Number(state.contentLog.blockNumber)),
      this,
    ));
    Object.defineProperty(records, "snapshot", { value: { blockNumber: Number(snapshot), blockHash } });
    this.candidateCache = { snapshot: Number(snapshot), blockHash, states, proposalIdsByHash, timestamps };
    return records;
  }
  async normalizeLog(vote, head) {
    const normalized = normalizeVote(vote, { endpoint: this.endpoint, queriedAt: new Date().toISOString(), subgraphBlock: String(head) });
    const logIndex = parseInt(createHash("sha256").update(String(vote.id)).digest("hex").slice(0, 7), 16);
    const payload = { id: vote.id, supportDetailed: vote.supportDetailed, votesRaw: vote.votesRaw, reason: vote.reason, blockNumber: vote.blockNumber, blockTimestamp: vote.blockTimestamp, transactionHash: vote.transactionHash, clientId: vote.clientId, voter: { id: vote.voter.id }, proposalId: vote.proposal.id };
    const base = { daoId: "nouns", sourceId: this.id, sourceRecordKey: `vote:${vote.id}`, chainId: 1, contractAddress: this.config.contractAddress, transactionHash: normalized.source.transactionHash, logIndex: null, blockNumber: normalized.blockNumber, blockHash: null, recordType: "vote", proposalId: normalized.proposal.id, payload, sourceKind: "nouns-subgraph", sourceEndpoint: this.endpoint, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head), externalId: String(vote.id) };
    return { raw: base, vote: { daoId: "nouns", sourceId: this.id, sourceRecordKey: `vote:${vote.id}`, chainId: 1, contractAddress: this.config.contractAddress, proposalId: normalized.proposalId, voter: getAddress(normalized.voter), support: normalized.support, reason: normalized.reason, voteWeight: normalized.voteWeight, blockNumber: normalized.blockNumber, timestamp: normalized.timestamp, transactionHash: normalized.source.transactionHash, logIndex, sourceKind: normalized.source.kind, sourceEndpoint: this.endpoint, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head), normalized } };
  }
}
module.exports = {
  NounsSubgraphSource,
  NOUNS_INDEX_QUERY: PAGE,
  NOUNS_PROPOSALS_QUERY: PROPOSALS_PAGE,
  NOUNS_NEW_PROPOSALS_QUERY: NEW_PROPOSALS_PAGE,
  NOUNS_REFRESH_PROPOSALS_QUERY: REFRESH_PROPOSALS,
  NOUNS_DAO_DATA_PROXY,
  NOUNS_CANDIDATE_START_BLOCK,
};
