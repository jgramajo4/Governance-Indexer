const { createHash } = require("node:crypto");
const { getAddress } = require("ethers");


const {
  historyDocumentSchema,
  normalizedProposalSchema,
  normalizedVoteSchema,
} = require("./governance-schema");
const { Support } = require("./governance-schema");
const {
  applyGovernanceLifecycle,
  deriveGovernanceStatus,
} = require("./lifecycle");

const DEFAULT_ENDPOINT = "https://www.nouns.camp/subgraphs/nouns";
const DEFAULT_PAGE_SIZE = 100;

function supportFromNouns(value) {
  const support = Number(value);
  if (support === 0) return Support.AGAINST;
  if (support === 1) return Support.FOR;
  if (support === 2) return Support.ABSTAIN;
  throw new RangeError(`Unknown Nouns support value: ${value}`);
}

const PROPOSAL_FIELDS = `
    id
    title
    description
    status
    proposer { id }
    targets
    values
    signatures
    calldatas
    createdTimestamp
    createdBlock
    startBlock
    endBlock
    quorumVotes
    forVotes
    againstVotes
    abstainVotes
`;

const VOTE_FIELDS = `
  id
  supportDetailed
  votesRaw
  reason
  blockNumber
  blockTimestamp
  transactionHash
  clientId
  voter { id }
  proposal {
    ${PROPOSAL_FIELDS}
  }
`;

const SNAPSHOT_QUERY = `
  query SnapshotBlock {
    _meta { block { number } }
  }
`;

const HISTORY_QUERY = `
  query VoterHistory($voter: String!, $first: Int!, $skip: Int!, $block: Int!) {
    votes(
      first: $first
      skip: $skip
      block: { number: $block }
      where: { voter: $voter }
      orderBy: blockNumber
      orderDirection: asc
    ) {
      ${VOTE_FIELDS}
    }
  }
`;

const PROPOSAL_QUERY = `
  query ProposalById($id: BigInt!, $block: Int!) {
    proposals(first: 1, block: { number: $block }, where: { id: $id }) {
      ${PROPOSAL_FIELDS}
    }
  }
`;

function isoFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError(`Invalid Unix timestamp: ${value}`);
  }
  return new Date(seconds * 1000).toISOString();
}

function proposalContentHash(proposal) {
  const material = JSON.stringify({
    description: proposal.description || "",
    targets: proposal.targets || [],
    values: proposal.values || [],
    signatures: proposal.signatures || [],
    calldatas: proposal.calldatas || [],
  });
  return createHash("sha256").update(material).digest("hex");
}

// Thin wrapper over the shared derivation so the subgraph adapter and the
// indexer cannot drift apart on what a proposal's outcome is.
function proposalOutcome(proposal, subgraphBlock) {
  return deriveGovernanceStatus({
    sourceState: proposal.status,
    endBlock: proposal.endBlock,
    forVotes: proposal.forVotes,
    againstVotes: proposal.againstVotes,
    quorumVotes: proposal.quorumVotes,
    finalizedBlock: subgraphBlock,
  }).effectiveStatus;
}

function normalizeActions(proposal) {
  const targets = proposal.targets || [];
  const values = proposal.values || [];
  const signatures = proposal.signatures || [];
  const calldatas = proposal.calldatas || [];
  const lengths = [targets.length, values.length, signatures.length, calldatas.length];
  if (!lengths.every((length) => length === targets.length)) {
    throw new Error(`Proposal ${proposal.id} has misaligned action arrays: ${lengths.join(",")}`);
  }
  return targets.map((target, index) => ({
    index,
    target: getAddress(target),
    valueWei: String(values[index]),
    signature: signatures[index] || "",
    calldata: calldatas[index] || "0x",
  }));
}

function normalizeProposal(proposal, context) {
  if (!proposal) throw new Error("Cannot normalize an empty proposal");
  const contentHash = proposalContentHash(proposal);
  // The lifecycle pass owns `outcome`, `effectiveStatus` and `trackingState`;
  // `state` stays the untouched upstream value.
  return normalizedProposalSchema.parse(applyGovernanceLifecycle({
    id: String(proposal.id),
    contentHash,
    title: String(proposal.title || ""),
    description: String(proposal.description || ""),
    proposer: getAddress(proposal.proposer.id),
    state: String(proposal.status || "UNKNOWN").toUpperCase(),
    createdBlock: String(proposal.createdBlock),
    createdAt: isoFromUnixSeconds(proposal.createdTimestamp),
    startBlock: String(proposal.startBlock),
    endBlock: String(proposal.endBlock),
    quorumVotes: String(proposal.quorumVotes),
    forVotes: String(proposal.forVotes),
    againstVotes: String(proposal.againstVotes),
    abstainVotes: String(proposal.abstainVotes),
    actions: normalizeActions(proposal),
  }, { finalizedBlock: context.subgraphBlock }));
}

function normalizeVote(rawVote, context) {
  const proposal = rawVote.proposal;
  if (!proposal) throw new Error(`Vote ${rawVote.id} has no proposal`);

  const normalizedProposal = normalizeProposal(proposal, context);
  const queriedAt = context.queriedAt;
  const normalized = {
    dao: "nouns",
    chainId: 1,
    proposalId: String(proposal.id),
    proposalContentHash: normalizedProposal.contentHash,
    voter: getAddress(rawVote.voter.id),
    support: supportFromNouns(rawVote.supportDetailed),
    reason: rawVote.reason == null || rawVote.reason === "" ? null : String(rawVote.reason),
    blockNumber: String(rawVote.blockNumber),
    timestamp: isoFromUnixSeconds(rawVote.blockTimestamp),
    voteWeight: String(rawVote.votesRaw),
    clientId: Number(rawVote.clientId),
    proposal: normalizedProposal,
    source: {
      kind: "nouns-subgraph",
      endpoint: context.endpoint,
      entityId: String(rawVote.id),
      transactionHash: String(rawVote.transactionHash),
      subgraphBlock: String(context.subgraphBlock),
      queriedAt,
    },
  };

  return normalizedVoteSchema.parse(normalized);
}


module.exports = { normalizeProposal, normalizeVote, proposalContentHash };
