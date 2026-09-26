const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TrackingState,
  applyGovernanceLifecycle,
} = require("../src/domain/lifecycle");

const SNAPSHOT = 24_000_000;

test("Nouns UI copy is not a canonical status; UPDATABLE is a pre-vote phase of PENDING", () => {
  const fromSource = applyGovernanceLifecycle(
    { state: "PENDING", timing: "block", endBlock: String(SNAPSHOT + 500), forVotes: "0", againstVotes: "0", quorumVotes: "1" },
    { finalizedBlock: SNAPSHOT },
  );
  assert.equal(fromSource.effectiveStatus, "PENDING");
  assert.equal(fromSource.trackingState, TrackingState.HOT);

  const fromGovernor = applyGovernanceLifecycle(
    { state: "UPDATABLE", timing: "block", endBlock: String(SNAPSHOT + 500), forVotes: "0", againstVotes: "0", quorumVotes: "1" },
    { finalizedBlock: SNAPSHOT },
  );
  assert.equal(fromGovernor.effectiveStatus, "UPDATABLE");
  assert.equal(fromGovernor.trackingState, TrackingState.HOT);
  assert.notEqual(fromGovernor.effectiveStatus, "OPEN_FOR_CHANGES");

  const uiCopy = applyGovernanceLifecycle(
    { state: "OPEN FOR CHANGES", timing: "block", endBlock: String(SNAPSHOT + 500), forVotes: "0", againstVotes: "0", quorumVotes: "1" },
    { finalizedBlock: SNAPSHOT },
  );
  assert.equal(uiCopy.sourceState, "OPEN_FOR_CHANGES");
  assert.equal(uiCopy.effectiveStatus, "OPEN_FOR_CHANGES");
  assert.equal(uiCopy.lifecycleReason, "source_state_post_vote");
  assert.equal(uiCopy.trackingState, TrackingState.HOT);
});
