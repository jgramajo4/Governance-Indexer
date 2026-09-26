const test = require("node:test");
const assert = require("node:assert/strict");
const { keccak256, toUtf8Bytes } = require("ethers");
const { candidateTargetId, adaptNounsCandidateLifecycle } = require("../src/domain/nouns-candidate");
const { canonicalProposalIdentity, assertCanonicalProposalIdentity } = require("../src/domain/proposal-identity");
const { deriveGovernanceStatus, presentProposal } = require("../src/domain/lifecycle");
const { blockRanges, resolveLogBlockBatchSize } = require("../src/domain/block-range");

test("Nouns candidate identity and lifecycle preserve canonical Gavel behavior", () => {
  const proposer = `0x${"11".repeat(20)}`;
  assert.equal(candidateTargetId(proposer, "slug"), `candidate:${proposer}:${keccak256(toUtf8Bytes("slug"))}`);
});

test("candidate lifecycle rejects malformed capabilities and closes updated or promoted candidates", () => {
  const live = { latestVersionValid: true, canceled: false, proposalIdToUpdate: "0", matchingProposalIds: [] };
  assert.deepEqual(adaptNounsCandidateLifecycle(live), { eligibility: "PRE_VOTE", mappingVersion: "nouns-candidate-lifecycle/1" });
  for (const input of [
    { ...live, latestVersionValid: false }, { ...live, canceled: true },
    { ...live, proposalIdToUpdate: "1" }, { ...live, matchingProposalIds: ["3"] },
  ]) assert.equal(adaptNounsCandidateLifecycle(input).eligibility, "CLOSED");
  assert.throws(() => adaptNounsCandidateLifecycle({ ...live, canceled: "false" }), /malformed/i);
});

test("proposal identity has a stable normalized representation and rejects ambiguity", () => {
  const actual = canonicalProposalIdentity({ dao: "ens", chainId: 1, governorAddress: `0x${"AB".repeat(20)}`, proposalId: "0" });
  assert.deepEqual(actual, { dao: "ens", chainId: 1, governorAddress: `0x${"ab".repeat(20)}`, proposalId: "0" });
  assert.deepEqual(assertCanonicalProposalIdentity(actual, actual), actual);
  assert.throws(() => canonicalProposalIdentity({ ...actual, proposalId: "00" }), /not canonical/i);
  assert.throws(() => assertCanonicalProposalIdentity(actual, { ...actual, dao: "nouns" }), /does not match/i);
});

test("proposal lifecycle and checkpoint range mechanics retain indexed semantics", () => {
  const result = deriveGovernanceStatus({ sourceState: "ACTIVE", endBlock: "99", finalizedBlock: "100", forVotes: "2", againstVotes: "3", quorumVotes: "1" });
  assert.deepEqual(result, { effectiveStatus: "DEFEATED", trackingState: "FINAL", reason: "voting_finalized_defeated" });
  assert.equal(presentProposal({ id: "1", state: "ACTIVE", outcome: "ACTIVE" }, {}).effectiveStatus, undefined);
  assert.deepEqual([...blockRanges(1, 6, 4)], [{ fromBlock: 1, toBlock: 4 }, { fromBlock: 5, toBlock: 6 }]);
  assert.equal(resolveLogBlockBatchSize({ names: ["TEST"], env: { TEST: "750" } }), 750);
  assert.throws(() => resolveLogBlockBatchSize({ names: ["TEST"], env: { TEST: "1.5" } }), /positive integer/);
});
