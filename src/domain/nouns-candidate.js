const { getAddress, keccak256, toUtf8Bytes } = require('ethers');

const NOUNS_CANDIDATE_MAPPING_VERSION = 'nouns-candidate-lifecycle/1';

function candidateTargetId(proposer, slug) {
  const address = getAddress(proposer).toLowerCase();
  if (typeof slug !== 'string') throw new TypeError('candidate slug must be a string');
  return `candidate:${address}:${keccak256(toUtf8Bytes(slug)).toLowerCase()}`;
}

function parseNounsCandidateTargetId(value) {
  const match = /^candidate:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/.exec(value);
  if (!match) throw new TypeError('invalid Nouns candidate target id');
  return Object.freeze({ proposer: match[1], slugHash: match[2] });
}

function adaptNounsCandidateLifecycle(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.latestVersionValid !== 'boolean'
      || typeof candidate.canceled !== 'boolean'
      || typeof candidate.proposalIdToUpdate !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(candidate.proposalIdToUpdate)
      || !Array.isArray(candidate.matchingProposalIds)
      || candidate.matchingProposalIds.some((id) => typeof id !== 'string' || !/^(0|[1-9][0-9]*)$/.test(id))) {
    throw new TypeError('malformed Nouns Proposal Candidate');
  }
  const eligible = candidate.latestVersionValid && !candidate.canceled
    && candidate.proposalIdToUpdate === '0' && candidate.matchingProposalIds.length === 0;
  return {
    eligibility: eligible ? 'PRE_VOTE' : 'CLOSED',
    mappingVersion: NOUNS_CANDIDATE_MAPPING_VERSION,
  };
}

module.exports = {
  NOUNS_CANDIDATE_MAPPING_VERSION,
  candidateTargetId,
  parseNounsCandidateTargetId,
  adaptNounsCandidateLifecycle,
};
