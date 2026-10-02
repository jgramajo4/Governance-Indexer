const { createHash } = require("node:crypto");
const {
  AbiCoder,
  Contract,
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

async function boundedLogs(provider, filter) {
  const from = Number(filter.fromBlock), to = Number(filter.toBlock);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Nouns log range is invalid");
  const logs = [];
  for (let start = from; start <= to; start += 1000) {
    const page = await provider.getLogs({ ...filter, fromBlock: start, toBlock: Math.min(start + 999, to) });
    if (!Array.isArray(page)) throw new Error("Ethereum log response is malformed");
    logs.push(...page);
  }
  return logs;
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
    this.endpoint = options.endpoint || process.env.NOUNS_SUBGRAPH_URL || "https://www.nouns.camp/subgraphs/nouns";
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
    let cached = this.candidateCache?.authenticatedLogs === true && Number(this.candidateCache.snapshot) <= Number(snapshot)
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
      boundedLogs(this.provider, {
        address: NOUNS_DAO_DATA_PROXY,
        topics: [candidateTopics],
        fromBlock: scanFrom,
        toBlock: Number(snapshot),
      }),
      boundedLogs(this.provider, {
        address: DAO_CONFIGS.nouns.currentGovernor,
        topics: [proposalCreatedTopic],
        fromBlock: scanFrom,
        toBlock: Number(snapshot),
      }),
    ]);
    if (!Array.isArray(candidateLogs) || !Array.isArray(proposalLogs)) throw new Error("Ethereum log response is malformed");

    // RPC log filters are not proof of provenance: authenticate every returned
    // event against the canonical block before decoding or adding it to cache.
    const eventHashes = new Map();
    for (const [logs, address, label] of [
      [candidateLogs, NOUNS_DAO_DATA_PROXY, "Proposal Candidate"],
      [proposalLogs, DAO_CONFIGS.nouns.currentGovernor, "ProposalCreated"],
    ]) {
      for (const entry of logs) {
        const number = Number(entry?.blockNumber);
        if (!Number.isSafeInteger(number) || number < scanFrom || number > Number(snapshot)
          || entry.address?.toLowerCase() !== address.toLowerCase()
          || !/^0x[0-9a-fA-F]{64}$/.test(entry.blockHash || "")) {
          throw new Error(`Nouns ${label} log provenance is invalid`);
        }
        if (!eventHashes.has(number)) {
          const block = await this.provider.getBlock(number);
          if (Number(block?.number) !== number || !/^0x[0-9a-fA-F]{64}$/.test(block.hash || "")) {
            throw new Error(`Nouns ${label} canonical block provenance is unavailable`);
          }
          eventHashes.set(number, block.hash.toLowerCase());
        }
        if (entry.blockHash.toLowerCase() !== eventHashes.get(number)) {
          throw new Error(`Nouns ${label} log block hash does not match canonical chain`);
        }
      }
    }

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
      if (block.hash?.toLowerCase() !== eventHashes.get(blockNumber)) {
        throw new Error(`Ethereum ${blockNumber} timestamp block hash does not match canonical event`);
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
    this.candidateCache = { snapshot: Number(snapshot), blockHash, authenticatedLogs: true, states, proposalIdsByHash, timestamps };
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
// The ABI matches NounsDAOLogicV4 / NounsDAOInterfaces; proposals() returns
// ProposalCondensedV2. Votes are read from this struct, not inferred from logs.
const NOUNS_RPC_ABI = [
  "function proposals(uint256) view returns ((uint256 id,address proposer,uint256 proposalThreshold,uint256 quorumVotes,uint256 eta,uint256 startBlock,uint256 endBlock,uint256 forVotes,uint256 againstVotes,uint256 abstainVotes,bool canceled,bool vetoed,bool executed,uint256 totalSupply,uint256 creationBlock))",
  "function state(uint256) view returns (uint8)",
  "function quorumVotes(uint256) view returns (uint256)",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,string[] signatures,bytes[] calldatas)",
  ...PROPOSAL_CREATED_ABI,
  "event ProposalUpdated(uint256 indexed id,address indexed proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string description,string updateMessage)",
  "event ProposalTransactionsUpdated(uint256 indexed id,address indexed proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,string updateMessage)",
  "event ProposalDescriptionUpdated(uint256 indexed id,address indexed proposer,string description,string updateMessage)",
  "event ProposalCanceled(uint256 id)", "event ProposalQueued(uint256 id,uint256 eta)",
  "event ProposalExecuted(uint256 id)", "event ProposalVetoed(uint256 id)",
  "event ProposalObjectionPeriodSet(uint256 indexed id,uint256 objectionPeriodEndBlock)",
  "event VoteCast(address indexed voter,uint256 proposalId,uint8 support,uint256 votes,string reason)",
  "event VoteCastWithClientId(address indexed voter,uint256 indexed proposalId,uint32 indexed clientId)",
];
const nounsRpcInterface = new Interface(NOUNS_RPC_ABI);
const NOUNS_STATES = ["PENDING", "ACTIVE", "CANCELED", "DEFEATED", "SUCCEEDED", "QUEUED", "EXPIRED", "EXECUTED", "VETOED", "OBJECTION_PERIOD", "UPDATABLE"];
const proposalEventNames = ["ProposalCreated", "ProposalUpdated", "ProposalTransactionsUpdated", "ProposalDescriptionUpdated", "ProposalCanceled", "ProposalQueued", "ProposalExecuted", "ProposalVetoed", "ProposalObjectionPeriodSet", "VoteCast"];
const proposalEventTopics = proposalEventNames.map((name) => nounsRpcInterface.getEvent(name).topicHash);
const voteTopic = nounsRpcInterface.getEvent("VoteCast").topicHash;

class NounsRpcSource {
  constructor(options = {}) {
    this.config = DAO_CONFIGS.nouns;
    this.id = this.config.source.id; // historical source identity must not fork
    this.provider = options.provider;
    this.rpcUrl = options.rpcUrl || process.env.ETHEREUM_RPC_URL;
    if (!this.provider || !this.rpcUrl || !/^https?:\/\//.test(this.rpcUrl)) throw new TypeError("Nouns RPC provider and HTTP(S) rpcUrl are required");
    this.publicEndpoint = options.sourcePublicEndpoint || process.env.PUBLIC_SOURCE_ENDPOINT || new URL(this.rpcUrl).origin;
    this.governor = options.governor || new Contract(this.config.currentGovernor, NOUNS_RPC_ABI, this.provider);
    this.fromBlock = Number(options.fromBlock ?? this.config.fromBlock);
    this.cutoverBlock = options.cutoverBlock;
    this.finalityDepth = Number(options.finalityDepth ?? 12);
    this.replayBlocks = Number(options.replayBlocks ?? 64);
  }
  async head() { return Math.max(0, Number(await this.provider.getBlockNumber()) - this.finalityDepth); }
  async canonicalSnapshotHash(snapshot, provenance) {
    return NounsSubgraphSource.prototype.canonicalSnapshotHash.call(this, snapshot, provenance);
  }
  async fetchCandidates(snapshot) { return NounsSubgraphSource.prototype.fetchCandidates.call(this, snapshot); }
  exportCandidateCache() {
    if (!this.candidateCache) return null;
    const cache = this.candidateCache;
    return JSON.parse(JSON.stringify({
      snapshot: cache.snapshot, blockHash: cache.blockHash, authenticatedLogs: cache.authenticatedLogs === true,
      states: [...cache.states], proposalIdsByHash: [...cache.proposalIdsByHash],
      timestamps: [...cache.timestamps],
    }, (_, value) => typeof value === "bigint" ? value.toString() : value));
  }
  hydrateCandidateCache(snapshot) {
    const bad = () => { throw new TypeError("Nouns candidate cache is malformed"); };
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || !Number.isSafeInteger(snapshot.snapshot) || snapshot.snapshot < NOUNS_CANDIDATE_START_BLOCK
      || !/^0x[0-9a-fA-F]{64}$/.test(snapshot.blockHash)
      || !Array.isArray(snapshot.states) || !Array.isArray(snapshot.proposalIdsByHash)
      || !Array.isArray(snapshot.timestamps)) bad();
    // A persisted cache is untrusted input. Validate the complete graph before
    // replacing the live cache, including log identities needed for replay.
    const logValid = (log) => log && typeof log === "object"
      && Number.isSafeInteger(log.blockNumber) && log.blockNumber >= NOUNS_CANDIDATE_START_BLOCK
      && log.blockNumber <= snapshot.snapshot && Number.isSafeInteger(log.index ?? log.logIndex)
      && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash);
    const states = new Map();
    for (const pair of snapshot.states) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || states.has(pair[0])) bad();
      const state = pair[1], content = state?.content;
      if (!content || typeof content !== "object" || !Array.isArray(content.values)
        || !content.values.every((v) => typeof v === "string" && /^\d+$/.test(v))
        || !["targets", "signatures", "calldatas"].every((key) => Array.isArray(content[key]) && content[key].length === content.values.length)
        || typeof content.proposer !== "string" || typeof content.slug !== "string"
        || typeof content.description !== "string" || typeof content.proposalIdToUpdate !== "string"
        || !/^0x[0-9a-fA-F]{64}$/.test(content.encodedProposalHash)
        || typeof state.canceled !== "boolean" || !Number.isSafeInteger(state.createdBlock)
        || !logValid(state.contentLog) || !logValid(state.latestLog)) bad();
      states.set(pair[0], state);
    }
    const proposalIdsByHash = new Map();
    for (const pair of snapshot.proposalIdsByHash) {
      if (!Array.isArray(pair) || pair.length !== 2 || !/^0x[0-9a-fA-F]{64}$/.test(pair[0])
        || proposalIdsByHash.has(pair[0]) || !Array.isArray(pair[1])
        || !pair[1].every((id) => typeof id === "string" && /^\d+$/.test(id))) bad();
      proposalIdsByHash.set(pair[0], pair[1]);
    }
    const timestamps = new Map();
    for (const pair of snapshot.timestamps) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0])
        || pair[0] > snapshot.snapshot || timestamps.has(pair[0])
        || !Number.isSafeInteger(pair[1]) || pair[1] < 0) bad();
      timestamps.set(pair[0], pair[1]);
    }
    // Detach from caller-owned mutable objects and reject non-JSON values.
    let copy;
    try { copy = JSON.parse(JSON.stringify(snapshot)); } catch { bad(); }
    if (JSON.stringify(copy) !== JSON.stringify(snapshot)) bad();
    this.candidateCache = { snapshot: snapshot.snapshot, blockHash: snapshot.blockHash.toLowerCase(),
      authenticatedLogs: snapshot.authenticatedLogs === true,
      states: new Map(copy.states), proposalIdsByHash: new Map(copy.proposalIdsByHash), timestamps: new Map(copy.timestamps) };
  }
  scanStart(fromBlock) {
    const cutover = Number(this.cutoverBlock);
    if (!Number.isSafeInteger(cutover) || cutover < 0) throw new Error("Nouns RPC cutoverBlock must be set before syncing");
    return Math.max(Number(fromBlock), cutover);
  }
  async verifyLogs(logs) {
    const blocks = new Map();
    for (const log of logs) {
      parseCanonicalLog(nounsRpcInterface, log, "governance");
      if (log.address?.toLowerCase() !== this.config.currentGovernor.toLowerCase()
        || !/^0x[0-9a-fA-F]{64}$/.test(log.blockHash || "")) throw new Error("Nouns governance log provenance is invalid");
      const number = Number(log.blockNumber);
      if (!blocks.has(number)) blocks.set(number, await this.provider.getBlock(number));
      const block = blocks.get(number);
      if (Number(block?.number) !== number || block.hash?.toLowerCase() !== log.blockHash.toLowerCase()) {
        throw new Error("Nouns governance log block hash does not match canonical chain");
      }
    }
  }
  async fetchRange(fromBlock, toBlock) {
    const start = this.scanStart(fromBlock);
    if (start > toBlock) return [];
    const logs = await boundedLogs(this.provider, { address: this.config.currentGovernor, fromBlock: start, toBlock: Number(toBlock), topics: [[voteTopic]] });
    if (!Array.isArray(logs)) throw new Error("Nouns vote log response is malformed");
    await this.verifyLogs(logs);
    return logs;
  }
  async fetchProposals(fromBlock, toBlock, snapshot = toBlock, context = {}) {
    const blockHash = await this.canonicalSnapshotHash(snapshot, { hash: null });
    const start = this.scanStart(fromBlock); // full mode never rescans subgraph-era history
    const logs = start > toBlock ? [] : await boundedLogs(this.provider, { address: this.config.currentGovernor, fromBlock: start, toBlock: Number(toBlock), topics: [proposalEventTopics] });
    if (!Array.isArray(logs)) throw new Error("Nouns proposal log response is malformed");
    await this.verifyLogs(logs);
    const changes = new Map();
    for (const log of [...logs].sort(logOrder)) {
      const event = parseCanonicalLog(nounsRpcInterface, log, "governance");
      const id = String(event.name === "VoteCast" ? event.args.proposalId : event.args.id);
      const prior = changes.get(id) || {};
      if (event.name === "ProposalCreated") {
        if (prior.created) throw new Error(`Nouns duplicate proposal creation ${id}`);
        prior.created = log;
        prior.description = String(event.args.description);
      }
      if (event.name === "ProposalUpdated" || event.name === "ProposalDescriptionUpdated") prior.description = String(event.args.description);
      changes.set(id, prior);
    }
    for (const row of context.refreshProposals || []) {
      const createdBlock = Number(row.normalized?.createdBlock);
      // If a post-cutover creation falls inside this replay and its log is
      // absent, the proposal was reorged away; do not read or refresh it.
      if (Number.isSafeInteger(createdBlock) && createdBlock >= start && createdBlock <= toBlock
          && !changes.get(String(row.proposalId))?.created) continue;
      if (!isTerminalRow(row) && !changes.has(String(row.proposalId))) changes.set(String(row.proposalId), {});
    }
    const existing = new Map((context.refreshProposals || []).map((row) => [String(row.proposalId), row]));
    const records = [];
    for (const [id, change] of changes) {
      const stored = existing.get(id) || (!change.created && typeof context.loadProposal === "function" ? await context.loadProposal(id) : null);
      const previous = stored?.normalized;
      if (!change.created && !previous) throw new Error(`Nouns proposal ${id} changed without canonical creation context`);
      const overrides = { blockTag: Number(snapshot) };
      const [details, stateRaw, quorum, actions] = await Promise.all([
        this.governor.proposals(id, overrides), this.governor.state(id, overrides),
        this.governor.quorumVotes(id, overrides), this.governor.getActions(id, overrides),
      ]);
      if (details.id != null && String(details.id) !== id) throw new Error(`Nouns proposal ${id} RPC identity mismatch`);
      const state = NOUNS_STATES[Number(stateRaw)];
      if (!state) throw new Error(`Nouns proposal ${id} RPC state is unknown`);
      const createdBlock = change.created?.blockNumber ?? details.creationBlock ?? previous?.createdBlock;
      if (createdBlock == null) throw new Error(`Nouns proposal ${id} creation block is unavailable`);
      const creation = change.created ? await this.provider.getBlock(Number(createdBlock)) : null;
      if (change.created && (Number(creation?.number) !== Number(createdBlock) || !Number.isSafeInteger(Number(creation?.timestamp)))) throw new Error(`Nouns proposal ${id} creation timestamp is unavailable`);
      const description = change.description ?? previous?.description;
      if (description == null) throw new Error(`Nouns proposal ${id} description is unavailable`);
      const [targets, values, signatures, calldatas] = actions;
      if (!Array.isArray(targets) || ![values, signatures, calldatas].every((array) => Array.isArray(array) && array.length === targets.length)) throw new Error(`Nouns proposal ${id} actions are malformed`);
      const proposal = {
        id, title: String(description).match(/^#\s+(.+)$/m)?.[1] || previous?.title || "", description,
        status: state, proposer: { id: getAddress(details.proposer ?? previous?.proposer) },
        targets: [...targets], values: values.map(String), signatures: [...signatures], calldatas: [...calldatas],
        createdTimestamp: change.created ? String(creation.timestamp) : String(Date.parse(previous.createdAt) / 1000),
        createdBlock: String(createdBlock), startBlock: String(details.startBlock), endBlock: String(details.endBlock),
        quorumVotes: String(quorum), forVotes: String(details.forVotes), againstVotes: String(details.againstVotes), abstainVotes: String(details.abstainVotes),
      };
      const normalized = { ...normalizeProposal(proposal, { subgraphBlock: String(snapshot) }), dao: "nouns", chainId: 1, venue: "governor", timing: "block",
        onchainContentHash: proposalCandidateHash({ proposer: proposal.proposer.id, targets, values, signatures, calldatas, description }),
      };
      const payload = { id, title: proposal.title, description, proposer: proposal.proposer, targets: proposal.targets, values: proposal.values, signatures: proposal.signatures, calldatas: proposal.calldatas, createdTimestamp: proposal.createdTimestamp, createdBlock: proposal.createdBlock, startBlock: proposal.startBlock, endBlock: proposal.endBlock };
      const refreshed = { daoId: "nouns", proposalId: id, contentHash: normalized.contentHash, normalized, actions: normalized.actions };
      if (!change.created) {
        // An existing proposal's raw provenance belongs to its original source.
        records.push({ proposal: refreshed, payload });
        continue;
      }
      records.push({
        raw: { daoId: "nouns", sourceId: this.id, sourceRecordKey: `proposal:${id}`, externalId: id, chainId: 1, contractAddress: this.config.contractAddress, transactionHash: null, logIndex: null, blockNumber: String(snapshot), blockHash, recordType: "proposal", proposalId: id, contentHash: normalized.contentHash, payload, sourceKind: "nouns-governor-logs", sourceEndpoint: this.rpcUrl, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(snapshot) },
        proposal: refreshed,
      });
    }
    Object.defineProperty(records, "snapshot", { value: { blockNumber: Number(snapshot), blockHash } });
    return records;
  }
  async normalizeLog(log, snapshot) {
    const event = parseCanonicalLog(nounsRpcInterface, log, "vote");
    if (event.name !== "VoteCast") throw new Error("Nouns vote log has an unexpected event");
    const block = await this.provider.getBlock(Number(log.blockNumber));
    if (Number(block?.number) !== Number(log.blockNumber) || !Number.isSafeInteger(Number(block?.timestamp))) throw new Error("Nouns vote block timestamp is unavailable");
    const index = logIndex(log);
    let clientId = 0;
    if (typeof this.provider.getTransactionReceipt === "function") {
      const receipt = await this.provider.getTransactionReceipt(log.transactionHash);
      if (!receipt || Number(receipt.blockNumber) !== Number(log.blockNumber)
        || receipt.blockHash?.toLowerCase() !== block.hash?.toLowerCase() || !Array.isArray(receipt.logs)) {
        throw new Error("Nouns vote receipt provenance is unavailable");
      }
      const companions = receipt.logs.filter((entry) => entry.address?.toLowerCase() === this.config.currentGovernor.toLowerCase()
        && entry.topics?.[0] === nounsRpcInterface.getEvent("VoteCastWithClientId").topicHash
        && logIndex(entry) > index).sort(logOrder);
      const nextVote = receipt.logs.filter((entry) => entry.address?.toLowerCase() === this.config.currentGovernor.toLowerCase()
        && entry.topics?.[0] === voteTopic && logIndex(entry) > index).map(logIndex).sort((a, b) => a - b)[0] ?? Infinity;
      for (const companion of companions) {
        if (logIndex(companion) >= nextVote) break;
        const parsed = parseCanonicalLog(nounsRpcInterface, companion, "vote client ID");
        if (getAddress(parsed.args.voter) === getAddress(event.args.voter) && String(parsed.args.proposalId) === String(event.args.proposalId)) {
          clientId = Number(parsed.args.clientId); break;
        }
      }
    }
    const id = `${log.transactionHash}-${index}`;
    const proposalId = String(event.args.proposalId);
    const support = ["AGAINST", "FOR", "ABSTAIN"][Number(event.args.support)];
    if (!support) throw new Error("Nouns vote support is invalid");
    const raw = { daoId: "nouns", sourceId: this.id, sourceRecordKey: `vote:${id}`, externalId: id, chainId: 1, contractAddress: this.config.contractAddress, transactionHash: log.transactionHash, logIndex: index, blockNumber: String(log.blockNumber), blockHash: log.blockHash || null, recordType: "vote", proposalId, payload: { topics: log.topics, data: log.data, clientId }, sourceKind: "nouns-governor-logs", sourceEndpoint: this.rpcUrl, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(snapshot) };
    return { raw, vote: { daoId: "nouns", sourceId: this.id, sourceRecordKey: raw.sourceRecordKey, chainId: 1, contractAddress: this.config.contractAddress, proposalId, voter: getAddress(event.args.voter), support, reason: event.args.reason === "" ? null : String(event.args.reason), voteWeight: String(event.args.votes), blockNumber: raw.blockNumber, timestamp: new Date(Number(block.timestamp) * 1000).toISOString(), transactionHash: log.transactionHash, logIndex: index, clientId, normalized: { clientId, source: { entityId: id } }, sourceKind: raw.sourceKind, sourceEndpoint: this.rpcUrl, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(snapshot) } };
  }
}

module.exports = {
  NounsRpcSource,
  NounsSubgraphSource,
  NOUNS_INDEX_QUERY: PAGE,
  NOUNS_PROPOSALS_QUERY: PROPOSALS_PAGE,
  NOUNS_NEW_PROPOSALS_QUERY: NEW_PROPOSALS_PAGE,
  NOUNS_REFRESH_PROPOSALS_QUERY: REFRESH_PROPOSALS,
  NOUNS_DAO_DATA_PROXY,
  NOUNS_CANDIDATE_START_BLOCK,
};
