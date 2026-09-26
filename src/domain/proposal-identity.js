"use strict";

const DAO = /^[a-z0-9][a-z0-9-]*$/;
const DECIMAL_ID = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

class ProposalIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProposalIdentityError";
    this.code = code;
  }
}

function invalid(name) {
  throw new ProposalIdentityError("INVALID_PROPOSAL_IDENTITY", `${name} is not canonical`);
}

function canonicalProposalIdentity(value, name = "proposal identity") {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(name);
  const { dao, chainId, governorAddress, proposalId } = value;
  if (typeof dao !== "string" || !DAO.test(dao)) invalid(`${name}.dao`);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) invalid(`${name}.chainId`);
  if (typeof governorAddress !== "string" || !ADDRESS.test(governorAddress)) invalid(`${name}.governorAddress`);
  if (typeof proposalId !== "string" || !DECIMAL_ID.test(proposalId)) invalid(`${name}.proposalId`);
  return Object.freeze({ dao, chainId, governorAddress: governorAddress.toLowerCase(), proposalId });
}

function assertCanonicalProposalIdentity(actualInput, expectedInput) {
  const actual = canonicalProposalIdentity(actualInput, "actual proposal identity");
  const expected = canonicalProposalIdentity(expectedInput, "expected proposal identity");
  if (actual.dao !== expected.dao
      || actual.chainId !== expected.chainId
      || actual.governorAddress !== expected.governorAddress
      || actual.proposalId !== expected.proposalId) {
    throw new ProposalIdentityError(
      "PROPOSAL_IDENTITY_MISMATCH",
      "The returned proposal identity does not match the requested proposal.",
    );
  }
  return actual;
}

function canonicalContentHash(value, name = "proposal content hash") {
  if (typeof value !== "string" || !CONTENT_HASH.test(value)) {
    throw new ProposalIdentityError("INVALID_PROPOSAL_CONTENT_HASH", `${name} is not canonical`);
  }
  return value;
}

function assertProposalBinding({ proposalIdentity, proposalContentHash, predictionIdentity, predictionContentHash }) {
  const identity = assertCanonicalProposalIdentity(predictionIdentity, proposalIdentity);
  const proposalHash = canonicalContentHash(proposalContentHash, "proposal content hash");
  const predictionHash = canonicalContentHash(predictionContentHash, "prediction proposal content hash");
  if (proposalHash !== predictionHash) {
    throw new ProposalIdentityError(
      "PROPOSAL_CONTENT_MISMATCH",
      "The prediction content hash does not match the proposal artifact.",
    );
  }
  return Object.freeze({ identity, contentHash: proposalHash });
}

module.exports = {
  ProposalIdentityError,
  canonicalProposalIdentity,
  assertCanonicalProposalIdentity,
  canonicalContentHash,
  assertProposalBinding,
};
