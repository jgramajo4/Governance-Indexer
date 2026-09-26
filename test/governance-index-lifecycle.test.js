const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DAO_CONFIGS,
  MemoryGovernanceStore,
  GovernanceSyncWorker,
  NounsSubgraphSource,
  EnsGovernorSource,
} = require("../src");
const {
  TrackingState,
  applyGovernanceLifecycle,
  deriveGovernanceStatus,
  trackingStateFor,
} = require("../src/domain/lifecycle");
const { NOUNS_REFRESH_PROPOSALS_QUERY } = require("../src/nouns-source");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "nouns-proposals-991-996.json"), "utf8"));
const SNAPSHOT = Number(FIXTURE.snapshotBlock);
const FINALITY_DEPTH = 12;
const SUBGRAPH_HEAD = SNAPSHOT + FINALITY_DEPTH;

function fixtureProposal(id) {
  const row = FIXTURE.proposals.find((proposal) => proposal.id === String(id));
  if (!row) throw new Error(`no fixture for proposal ${id}`);
  const { expected, ...subgraphRow } = row;
  return { subgraphRow, expected };
}

function nounsSubgraph(options = {}) {
  const proposals = (options.proposals || FIXTURE.proposals).map(({ expected, ...row }) => row);
  const calls = [];
  const fetch = async (_endpoint, init) => {
    const { query, variables } = JSON.parse(init.body);
    const operation = query.includes("votes(") ? "votes"
      : query.includes("id_in") ? "refreshProposals"
      : query.includes("createdBlock_gte") ? "newProposals"
      : query.includes("proposals(") ? "allProposals"
      : "meta";
    calls.push({ operation, variables });
    if (operation === "meta") return json({ _meta: { block: { number: SUBGRAPH_HEAD } } });
    if (operation === "votes") return json({ votes: [] });
    const meta = { _meta: { block: { number: variables.snapshot, hash: `0x${"12".repeat(32)}` } } };
    if (operation === "refreshProposals") {
      const wanted = new Set((variables.ids || []).map(String));
      return json({ ...meta, proposals: proposals.filter((row) => wanted.has(String(row.id))) });
    }
    if (operation === "newProposals") {
      const after = String(variables.after || "");
      const from = BigInt(variables.from);
      return json({
        ...meta,
        proposals: proposals
          .filter((row) => BigInt(row.createdBlock) >= from && String(row.id) > after)
          .sort((a, b) => (String(a.id) > String(b.id) ? 1 : -1)),
      });
    }
    const after = String(variables.after || "");
    return json({ ...meta, proposals: proposals.filter((row) => String(row.id) > after).sort((a, b) => (String(a.id) > String(b.id) ? 1 : -1)) });
  };
  const source = new NounsSubgraphSource({ fetch, finalityDepth: FINALITY_DEPTH, replayBlocks: 8, pageSize: 500 });
  return { source, calls };
}

function json(data) {
  return { ok: true, async json() { return { data }; } };
}

function refreshedIds(calls) {
  return calls.filter((call) => call.operation === "refreshProposals").flatMap((call) => call.variables.ids.map(String));
}

test("a stale source ACTIVE on a finalized losing vote derives DEFEATED and FINAL", () => {
  for (const id of ["992", "993", "995"]) {
    const { subgraphRow, expected } = fixtureProposal(id);
    const derived = deriveGovernanceStatus({
      sourceState: subgraphRow.status,
      timing: "block",
      endBlock: subgraphRow.endBlock,
      finalizedBlock: FIXTURE.snapshotBlock,
      forVotes: subgraphRow.forVotes,
      againstVotes: subgraphRow.againstVotes,
      quorumVotes: subgraphRow.quorumVotes,
    });
    assert.equal(subgraphRow.status, "ACTIVE", `proposal ${id} fixture must carry the stale upstream value`);
    assert.equal(derived.effectiveStatus, expected.effectiveStatus, `proposal ${id} effective status`);
    assert.equal(derived.trackingState, TrackingState.FINAL, `proposal ${id} tracking state`);
  }
});

test("every lifecycle phase maps to the tracking state that matches how much it can still change", () => {
  const hot = ["UPDATABLE", "PENDING", "ACTIVE", "OBJECTION_PERIOD", "SPONSORING", "REVIEW"];
  const warm = ["SUCCEEDED", "QUEUED"];
  const final = ["DEFEATED", "EXECUTED", "CANCELLED", "CANCELED", "VETOED", "EXPIRED", "SPONSORSHIP_EXPIRED"];
  for (const status of hot) assert.equal(trackingStateFor(status), TrackingState.HOT, status);
  for (const status of warm) assert.equal(trackingStateFor(status), TrackingState.WARM, status);
  for (const status of final) assert.equal(trackingStateFor(status), TrackingState.FINAL, status);
  assert.equal(trackingStateFor("SOME_NEW_UPSTREAM_STATE"), TrackingState.HOT);
});

test("a pending proposal whose voting has not started stays trackable, and an active one stays HOT", () => {
  const { subgraphRow: pending } = fixtureProposal("996");
  const derivedPending = applyGovernanceLifecycle(
    { state: pending.status, timing: "block", endBlock: pending.endBlock, forVotes: pending.forVotes, againstVotes: pending.againstVotes, quorumVotes: pending.quorumVotes },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  assert.equal(derivedPending.effectiveStatus, "PENDING");
  assert.equal(derivedPending.trackingState, TrackingState.HOT);
  assert.equal(derivedPending.lifecycleReason, "voting_open");

  const derivedActive = applyGovernanceLifecycle(
    { state: "ACTIVE", timing: "block", endBlock: String(SNAPSHOT + 500), forVotes: "1", againstVotes: "0", quorumVotes: "9" },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  assert.equal(derivedActive.effectiveStatus, "ACTIVE");
  assert.equal(derivedActive.trackingState, TrackingState.HOT);
});

test("a proposal that won its finalized vote is WARM until the source reports what happened next", () => {
  const won = { state: "ACTIVE", timing: "block", endBlock: "100", forVotes: "90", againstVotes: "10", quorumVotes: "50" };
  const succeeded = applyGovernanceLifecycle(won, { finalizedBlock: "200" });
  assert.equal(succeeded.effectiveStatus, "SUCCEEDED");
  assert.equal(succeeded.trackingState, TrackingState.WARM);

  const queued = applyGovernanceLifecycle({ ...won, state: "QUEUED" }, { finalizedBlock: "200" });
  assert.equal(queued.effectiveStatus, "QUEUED");
  assert.equal(queued.trackingState, TrackingState.WARM);
  assert.equal(queued.lifecycleReason, "source_state_post_vote");
});

test("the source state is preserved alongside the derived status rather than overwritten", () => {
  const { subgraphRow } = fixtureProposal("992");
  const derived = applyGovernanceLifecycle(
    { state: subgraphRow.status, timing: "block", endBlock: subgraphRow.endBlock, forVotes: subgraphRow.forVotes, againstVotes: subgraphRow.againstVotes, quorumVotes: subgraphRow.quorumVotes },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  assert.equal(derived.state, "ACTIVE", "`state` keeps its existing meaning for external consumers");
  assert.equal(derived.sourceState, "ACTIVE");
  assert.equal(derived.effectiveStatus, "DEFEATED");
  assert.equal(derived.outcome, "DEFEATED", "`outcome` remains the derived verdict");
  assert.equal(derived.trackingState, TrackingState.FINAL);
  assert.deepEqual(applyGovernanceLifecycle(derived, { finalizedBlock: FIXTURE.snapshotBlock }), derived);
});
