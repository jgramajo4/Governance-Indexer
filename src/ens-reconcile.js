const { createHash } = require("node:crypto");
const { Contract, Interface, id, keccak256, toUtf8Bytes } = require("ethers");
const { DAO_CONFIGS } = require("./config");

const ENS_ABI = [
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function proposalDeadline(uint256 proposalId) view returns (uint256)",
  "function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes,uint256 forVotes,uint256 abstainVotes)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
  "function hashProposal(address[] targets,uint256[] values,bytes[] calldatas,bytes32 descriptionHash) pure returns (uint256)",
];
const STATE_LABELS = ["PENDING", "ACTIVE", "CANCELLED", "DEFEATED", "SUCCEEDED", "QUEUED", "EXPIRED", "EXECUTED"];
const governorInterface = new Interface(ENS_ABI);
function decimal(value, label) {
  try { const parsed = BigInt(value); if (parsed < 0n) throw new Error(); return parsed.toString(); }
  catch { throw new TypeError(`${label} must be an unsigned integer`); }
}
function executableCalldata(action) {
  if (!action.signature) return action.calldata;
  return `${id(action.signature).slice(0, 10)}${action.calldata.replace(/^0x/, "")}`;
}
function indexedProposalContentHash(proposal) {
  const material = {
    description: proposal.description,
    targets: proposal.actions.map((action) => action.target),
    values: proposal.actions.map((action) => action.valueWei),
    signatures: proposal.actions.map((action) => action.signature),
    calldatas: proposal.actions.map((action) => action.calldata),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

async function validateIndexedEnsProposal({ provider, indexed }) {
  const config = DAO_CONFIGS.ens;
  const governor = new Contract(config.contractAddress, ENS_ABI, provider);
  const requestedId = decimal(indexed.id, "proposal id");
  if (indexed.id !== requestedId || indexed.dao !== "ens" || indexed.chainId !== 1) {
    throw new Error("Indexed ENS proposal identity does not match the request");
  }
  if (indexedProposalContentHash(indexed) !== indexed.contentHash) {
    throw new Error("Indexed ENS proposal content hash does not match canonical proposal material");
  }
  const targets = indexed.actions.map((action) => action.target);
  const values = indexed.actions.map((action) => action.valueWei);
  const calldatas = indexed.actions.map(executableCalldata);
  const descriptionHash = keccak256(toUtf8Bytes(indexed.description));
  const [stateRaw, snapshotRaw, deadlineRaw, votesRaw, canonicalIdRaw] = await Promise.all([
    governor.state(requestedId), governor.proposalSnapshot(requestedId), governor.proposalDeadline(requestedId),
    governor.proposalVotes(requestedId), governor.hashProposal(targets, values, calldatas, descriptionHash),
  ]);
  if (decimal(canonicalIdRaw, "canonical proposal id") !== requestedId) {
    throw new Error("Canonical ENS proposal hash differs from indexed metadata");
  }
  const snapshot = decimal(snapshotRaw, "proposal snapshot block");
  const deadline = decimal(deadlineRaw, "proposal deadline block");
  if (snapshot !== indexed.startBlock || deadline !== indexed.endBlock) {
    throw new Error("Canonical ENS voting window differs from indexed metadata");
  }
  const state = STATE_LABELS[Number(stateRaw)] || `UNKNOWN_${Number(stateRaw)}`;
  const against = decimal(votesRaw.againstVotes ?? votesRaw[0], "against votes");
  const forVotes = decimal(votesRaw.forVotes ?? votesRaw[1], "for votes");
  const abstain = decimal(votesRaw.abstainVotes ?? votesRaw[2], "abstain votes");
  const quorum = decimal(await governor.quorum(snapshot), "quorum votes");
  return { ...indexed, state, outcome: state, startBlock: snapshot, endBlock: deadline, quorumVotes: quorum, againstVotes: against, forVotes, abstainVotes: abstain };
}
module.exports = { ENS_ABI, validateIndexedEnsProposal };
