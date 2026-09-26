const { createHash } = require("node:crypto");
const { Contract, getAddress } = require("ethers");
const { normalizedProposalSchema, Support } = require("./domain/governance-schema");

const CHAIN_ID = 1;
const VOTING_ADDRESS = getAddress("0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC");
const QUORUM = 2_000_000n * 10n ** 18n;
const VOTING_START_OFFSET = 2 * 24 * 60 * 60;
const VOTING_YAY_END_OFFSET = 5 * 24 * 60 * 60;
const VOTING_NAY_END_OFFSET = 6 * 24 * 60 * 60;
const ABI = [
  "function proposalsLength() view returns (uint256)",
  "function proposals(uint256 id) view returns (bool executed,address proposer,string proposalDocument,uint256 publishTime,uint256 voteCallTime,uint256 sponsorship,uint256 yayVotes,uint256 nayVotes,uint256 sponsorInterval,uint256 votingInterval)",
  "function getActions(uint256 id) view returns ((address callContract,bytes data,uint256 value)[])",
];

function field(value, name, index) { return value?.[name] ?? value?.[index]; }
function decimal(value, label) {
  try { const parsed = BigInt(value); if (parsed < 0n) throw new Error(); return parsed.toString(); }
  catch { throw new TypeError(`${label} must be an unsigned integer`); }
}
function canonicalActions(result) {
  return Array.from(result || []).map((action, index) => ({
    index,
    target: getAddress(field(action, "callContract", 0)),
    valueWei: decimal(field(action, "value", 2), `action ${index} value`),
    signature: "",
    calldata: String(field(action, "data", 1)).toLowerCase(),
  }));
}
function contentHash(proposalResult, actions) {
  return createHash("sha256").update(JSON.stringify({
    proposalDocument: String(field(proposalResult, "proposalDocument", 2)),
    actions: actions.map(({ target, valueWei, calldata }) => ({ target, valueWei, calldata })),
  })).digest("hex");
}
function proposalState(result, nowSeconds) {
  if (Boolean(field(result, "executed", 0))) return "EXECUTED";
  const publish = Number(field(result, "publishTime", 3));
  const voteStart = Number(field(result, "voteCallTime", 4));
  const yay = BigInt(field(result, "yayVotes", 6));
  const nay = BigInt(field(result, "nayVotes", 7));
  if (voteStart === 0) return nowSeconds < publish + 30 * 24 * 60 * 60 ? "SPONSORING" : "SPONSORSHIP_EXPIRED";
  if (nowSeconds <= voteStart + VOTING_START_OFFSET) return "REVIEW";
  if (nowSeconds < voteStart + VOTING_NAY_END_OFFSET) return nowSeconds < voteStart + VOTING_YAY_END_OFFSET ? "ACTIVE" : "ACTIVE_NAY_ONLY";
  return yay >= QUORUM && yay > nay ? "SUCCEEDED" : "DEFEATED";
}

async function fetchRailgunProposal({ provider, voting: suppliedVoting, proposalId, blockTag = "latest" }) {
  const id = decimal(proposalId, "proposal id");
  const voting = suppliedVoting || new Contract(VOTING_ADDRESS, ABI, provider);
  const overrides = { blockTag };
  const [result, actionResult, block] = await Promise.all([
    voting.proposals(id, overrides), voting.getActions(id, overrides), provider.getBlock(blockTag),
  ]);
  const actions = canonicalActions(actionResult);
  const publishTime = Number(field(result, "publishTime", 3));
  const voteCallTime = Number(field(result, "voteCallTime", 4));
  const document = String(field(result, "proposalDocument", 2));
  const uri = document.startsWith("ipfs://") ? document : `ipfs://${document}`;
  const state = proposalState(result, Number(block.timestamp));
  return normalizedProposalSchema.parse({
    id,
    contentHash: contentHash(result, actions),
    title: `Railgun proposal ${id}`,
    description: uri,
    proposer: getAddress(field(result, "proposer", 1)),
    state,
    outcome: state,
    createdBlock: "0",
    createdAt: new Date(publishTime * 1000).toISOString(),
    startBlock: "0",
    endBlock: "0",
    quorumVotes: QUORUM.toString(),
    forVotes: decimal(field(result, "yayVotes", 6), "yay votes"),
    againstVotes: decimal(field(result, "nayVotes", 7), "nay votes"),
    abstainVotes: "0",
    actions,
    dao: "railgun-eth",
    chainId: CHAIN_ID,
    venue: "railgun-voting",
    timing: "timestamp",
    startTime: voteCallTime ? new Date((voteCallTime + VOTING_START_OFFSET) * 1000).toISOString() : null,
    endTime: voteCallTime ? new Date((voteCallTime + VOTING_NAY_END_OFFSET) * 1000).toISOString() : null,
    metadataUrl: uri,
    choices: [Support.AGAINST, Support.FOR],
  });
}

async function fetchRailgunProposalCount({ provider, blockTag = "latest" }) {
  const voting = new Contract(VOTING_ADDRESS, ABI, provider);
  return voting.proposalsLength({ blockTag });
}

module.exports = { fetchRailgunProposal, fetchRailgunProposalCount };
