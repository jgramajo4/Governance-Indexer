const { candidateTargetId } = require("./domain/nouns-candidate");
const { canonicalGateActions } = require("./gate-action");

const HASH = /^0x[0-9a-f]{64}$/;

function canonicalCandidateTarget(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("candidate target is invalid");
  if (row.dao !== "nouns" || row.kind !== "candidate") throw new TypeError("candidate target kind is invalid");
  if (typeof row.proposer !== "string" || row.proposer !== row.proposer.toLowerCase()) {
    throw new TypeError("candidate proposer must be canonical lowercase");
  }
  const expectedTargetId = candidateTargetId(row.proposer, row.slug);
  if (row.targetId !== expectedTargetId) throw new TypeError("candidate target identity mismatch");
  if (!HASH.test(row.contentHash)) throw new TypeError("candidate content hash is invalid");
  if (row.mappingVersion !== "nouns-candidate-lifecycle/1") throw new TypeError("candidate mapping version is invalid");
  if (!(["ACTIVE", "CANCELED"].includes(row.nativeState))) throw new TypeError("candidate native state is invalid");
  if (!(["PRE_VOTE", "CLOSED"].includes(row.eligibility))) throw new TypeError("candidate eligibility is invalid");
  if (row.nativeState === "CANCELED" && row.eligibility !== "CLOSED") {
    throw new TypeError("canceled candidate must be closed");
  }
  if (row.eligibility === "PRE_VOTE" && row.nativeState !== "ACTIVE") {
    throw new TypeError("PRE_VOTE candidate must be active");
  }
  if (!row.latestVersion || typeof row.latestVersion !== "object" || Array.isArray(row.latestVersion)) {
    throw new TypeError("candidate latest version is invalid");
  }
  return { ...row, actions: canonicalGateActions(row.actions, { exact: true }) };
}

module.exports = { canonicalCandidateTarget };
