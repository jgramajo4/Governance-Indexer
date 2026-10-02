const { sanitizeConfig, sanitizeProvenance } = require("./provenance");
const { redactErrorMessage } = require("./redaction");
const { canonicalGateActions } = require("./gate-action");
const { canonicalCandidateTarget } = require("./candidate-target");
const { DAO_CONFIGS } = require("./config");
const { proposalContentHash } = require("./domain/nouns-history");

function chainEventKey(row) {
  return `${row.chainId}:${String(row.contractAddress).toLowerCase()}:${String(row.transactionHash).toLowerCase()}:${row.logIndex}`;
}
function eventKey(row) {
  return row.sourceRecordKey ? `${row.daoId}:${row.sourceId}:${row.sourceRecordKey}` : chainEventKey(row);
}
function compareCursor(a, b) {
  const ab = BigInt(a.blockNumber || 0); const bb = BigInt(b.blockNumber || 0);
  if (ab !== bb) return ab < bb ? -1 : 1;
  const transaction = String(a.transactionHash || "").toLowerCase().localeCompare(String(b.transactionHash || "").toLowerCase());
  return transaction || Number(a.logIndex || 0) - Number(b.logIndex || 0);
}
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([String(row.blockNumber), String(row.transactionHash).toLowerCase(), Number(row.logIndex || 0)])).toString("base64url");
}
function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(parsed) || parsed.length !== 3 || !/^\d+$/.test(parsed[0]) || !/^0x[0-9a-f]{64}$/.test(parsed[1]) || !Number.isSafeInteger(parsed[2]) || parsed[2] < 0) throw new Error();
    return { blockNumber: parsed[0], transactionHash: parsed[1], logIndex: parsed[2] };
  } catch { throw new TypeError("invalid cursor"); }
}
function encodeProposalCursor(id) { return Buffer.from(JSON.stringify(["proposal", String(id)])).toString("base64url"); }
function decodeProposalCursor(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString()); if (parsed[0] !== "proposal" || !/^\d+$/.test(parsed[1])) throw new Error(); return parsed[1]; }
  catch { throw new TypeError("invalid cursor"); }
}
const { TrackingState, trackingStateFor, presentProposal } = require("./domain/lifecycle");
const { assertCanonicalProposalIdentity } = require("./domain/proposal-identity");
function proposalRead(row) {
  const normalized = row.normalized || {};
  for (const key of ["dao", "chainId", "governorAddress"]) {
    if (row[key] !== undefined && normalized[key] !== undefined
      && (key === "governorAddress"
        ? String(row[key]).toLowerCase() !== String(normalized[key]).toLowerCase()
        : row[key] !== normalized[key])) {
      throw new Error(`Stored proposal ${key} conflicts with its normalized document`);
    }
  }
  if (row.identity !== undefined && normalized.identity !== undefined) {
    assertCanonicalProposalIdentity(normalized.identity, row.identity);
  }
  return {
    ...presentProposal(normalized, row), daoId: row.daoId, proposalId: row.proposalId,
    ...(row.dao !== undefined ? { dao: row.dao } : {}),
    ...(row.chainId !== undefined ? { chainId: row.chainId } : {}),
    ...(row.governorAddress !== undefined ? { governorAddress: row.governorAddress } : {}),
    ...(row.identity !== undefined ? { identity: row.identity } : {}),
  };
}
// Mirrors the Postgres store: a WARM proposal is re-read on a slower cadence
// than a live vote, and a FINAL one is not re-read at all.
const DEFAULT_WARM_REFRESH_MS = 15 * 60 * 1000;
function canonicalMaterial(row) { return JSON.stringify({ blockNumber: String(row.blockNumber), blockHash: row.blockHash || null, recordType: row.recordType, proposalId: row.proposalId || null, contentHash: row.contentHash || null, payload: row.payload }); }
function immutableEventMaterial(row) { return JSON.stringify({ recordType: row.recordType, proposalId: row.proposalId || null, contentHash: row.contentHash || null, payload: row.payload }); }

class MemoryGovernanceStore {
  constructor({ clock = () => new Date() } = {}) { this.clock = clock; this.daos = new Map(); this.sources = new Map(); this.rawRecords = []; this.proposals = []; this.proposalActions = []; this.targets = new Map(); this.voteEvents = []; this.delegationEvents = []; this.checkpoints = new Map(); this.candidateSnapshots = new Map(); this.proposalRefreshes = new Map(); this._keys = new Set(); this._locks = new Map(); }
  async transaction(callback) {
    const snapshot = structuredClone({ daos: this.daos, sources: this.sources, rawRecords: this.rawRecords, proposals: this.proposals, proposalActions: this.proposalActions, targets: this.targets, voteEvents: this.voteEvents, delegationEvents: this.delegationEvents, checkpoints: this.checkpoints, candidateSnapshots: this.candidateSnapshots, proposalRefreshes: this.proposalRefreshes, keys: this._keys });
    try { return await callback(this); } catch (error) { Object.assign(this, { ...snapshot, _keys: snapshot.keys }); throw error; }
  }
  async withSourceLock(daoId, sourceId, callback) {
    const key = `${daoId}:${sourceId}`; const previous = this._locks.get(key) || Promise.resolve();
    let release; const current = new Promise((resolve) => { release = resolve; }); this._locks.set(key, current);
    await previous;
    try { return await callback(); } finally { release(); if (this._locks.get(key) === current) this._locks.delete(key); }
  }
  upsertDao(row) { this.daos.set(row.id, sanitizeConfig({ ...this.daos.get(row.id), ...row })); }
  upsertSource(row) { this.sources.set(`${row.daoId}:${row.id}`, sanitizeProvenance({ ...this.sources.get(`${row.daoId}:${row.id}`), ...row })); }
  getCheckpoint(daoId, sourceId) { return this.checkpoints.get(`${daoId}:${sourceId}`) || null; }
  getCandidateSnapshot(daoId, sourceId) {
    return structuredClone(this.candidateSnapshots.get(`${daoId}:${sourceId}`) || null);
  }
  setCandidateSnapshot({ daoId, sourceId, checkpointBlock, checkpointHash, snapshot }) {
    if (!Number.isSafeInteger(checkpointBlock) || checkpointBlock < 0
        || typeof checkpointHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(checkpointHash)
        || snapshot?.snapshot !== checkpointBlock || snapshot?.blockHash !== checkpointHash) {
      throw new TypeError('candidate snapshot checkpoint provenance is invalid');
    }
    const key = `${daoId}:${sourceId}`;
    if (this.candidateSnapshots.has(key) && this.candidateSnapshots.get(key).checkpointBlock > checkpointBlock) return;
    this.candidateSnapshots.set(key, structuredClone({ checkpointBlock, checkpointHash, snapshot }));
  }
  setCheckpoint(row) {
    row = { ...row, lastError: row.lastError == null ? null : redactErrorMessage(row.lastError) };
    const key = `${row.daoId}:${row.sourceId}`; const existing = this.checkpoints.get(key);
    if (existing && BigInt(row.nextBlock) < BigInt(existing.nextBlock)) {
      this.checkpoints.set(key, { ...existing, updatedAt: row.updatedAt, lastError: row.lastError, lastFullScanAt: row.lastFullScanAt || existing.lastFullScanAt || null });
      return;
    }
    this.checkpoints.set(key, { ...existing, ...row, lastFullScanAt: row.lastFullScanAt || existing?.lastFullScanAt || null });
  }
  refreshMaterializedProposal({ daoId, sourceId, proposalId, contentHash, snapshot, payload }) {
    if (daoId !== 'nouns' || sourceId !== 'nouns-subgraph'
        || !/^(0|[1-9][0-9]*)$/.test(String(proposalId))
        || !/^[0-9a-fA-F]{64}$/.test(contentHash || '')
        || !Number.isSafeInteger(snapshot?.blockNumber) || snapshot.blockNumber < 0
        || !/^0x[0-9a-fA-F]{64}$/.test(snapshot?.blockHash || '')
        || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || String(payload.id) !== String(proposalId) || typeof payload.description !== 'string'
        || !['targets', 'values', 'signatures', 'calldatas'].every((key) => Array.isArray(payload[key]))
        || !['values', 'signatures', 'calldatas'].every((key) => payload[key].length === payload.targets.length)
        || proposalContentHash(payload) !== contentHash) {
      throw new TypeError('invalid materialized Nouns proposal provenance');
    }
    const row = this.rawRecords.find((item) => item.daoId === daoId && item.sourceId === sourceId
      && item.sourceRecordKey === `proposal:${proposalId}` && item.recordType === 'proposal'
      && String(item.proposalId) === String(proposalId));
    if (!row || BigInt(row.blockNumber) > BigInt(snapshot.blockNumber)
        || BigInt(row.observedHead) > BigInt(snapshot.blockNumber)
        || (Number(row.blockNumber) === snapshot.blockNumber && row.blockHash === snapshot.blockHash
          && row.contentHash !== contentHash)) {
      throw new Error(`materialized Nouns proposal provenance is stale or missing for ${proposalId}`);
    }
    const key = `${daoId}:${sourceId}:${proposalId}`;
    const previous = this.proposalRefreshes.get(key);
    if (previous && (previous.blockNumber > snapshot.blockNumber
      || (previous.blockNumber === snapshot.blockNumber && previous.blockHash === snapshot.blockHash
        && (previous.contentHash !== contentHash || immutableEventMaterial({ payload: previous.payload }) !== immutableEventMaterial({ payload }))))) {
      throw new Error(`materialized Nouns proposal provenance is stale or conflicting for ${proposalId}`);
    }
    this.proposalRefreshes.set(key, structuredClone({ blockNumber: snapshot.blockNumber,
      blockHash: snapshot.blockHash, contentHash, payload, ingestedAt: new Date(this.clock()).toISOString() }));
  }
  upsertProposal(row) {
    const actions = row.actions === undefined
      ? undefined
      : canonicalGateActions(row.actions, { indexKey: "index" });
    const effectiveStatus = row.normalized?.effectiveStatus || row.normalized?.outcome || "UNKNOWN";
    const stored = {
      ...row,
      effectiveStatus,
      trackingState: row.normalized?.trackingState || trackingStateFor(effectiveStatus),
      lifecycleReason: row.normalized?.lifecycleReason || null,
      updatedAt: new Date().toISOString(),
    };
    const index = this.proposals.findIndex((x) => x.daoId === row.daoId && x.proposalId === row.proposalId);
    if (index < 0) {
      this.proposals.push({ lastObservedBlock: row.lastObservedBlock ?? null, ...stored });
    } else {
      const previous = this.proposals[index];
      const observed = [previous.lastObservedBlock, row.lastObservedBlock].filter((value) => value != null).map(BigInt);
      this.proposals[index] = {
        ...previous,
        ...stored,
        lastObservedBlock: observed.length ? String(observed.reduce((a, b) => (a > b ? a : b))) : null,
      };
    }
    if (actions !== undefined) {
      this.proposalActions = this.proposalActions.filter((x) => !(x.daoId === row.daoId && x.proposalId === row.proposalId));
      this.proposalActions.push(...actions.map(({ actionIndex, ...action }) => ({
        daoId: row.daoId, proposalId: row.proposalId, index: actionIndex, ...action,
      })));
    }
  }
  upsertTarget(row) {
    const target = canonicalCandidateTarget(row);
    this.targets.set(`${target.dao}:${target.targetId}`, structuredClone(target));
  }
  insertVote(row) { const safe = sanitizeProvenance(row); const key = eventKey({ ...safe, contractAddress: safe.contractAddress || "" }); if (this._keys.has(`v:${key}`)) return false; this._keys.add(`v:${key}`); this.voteEvents.push(safe); return true; }
  insertDelegation(row) { const safe = sanitizeProvenance(row); const key = eventKey(safe); if (this._keys.has(`d:${key}`)) return false; this._keys.add(`d:${key}`); this.delegationEvents.push(safe); return true; }
  ingest(record) {
    const raw = sanitizeProvenance({ ...record.raw, proposalId: record.raw.proposalId || record.proposal?.proposalId || record.vote?.proposalId || null, contentHash: record.raw.contentHash || record.proposal?.contentHash || null }); const key = eventKey(raw);
    const existingIndex = this.rawRecords.findIndex((x) => eventKey(x) === key);
    const existing = this.rawRecords[existingIndex];
    if (existing) {
      const refreshableProposal = raw.recordType === "proposal" && raw.sourceRecordKey;
      const refreshableCandidate = raw.recordType === "proposal_candidate" && raw.sourceRecordKey;
      if (refreshableCandidate
          && String(raw.blockNumber) === String(existing.blockNumber)
          && (raw.blockHash || null) === (existing.blockHash || null)
          && immutableEventMaterial(existing) !== immutableEventMaterial(raw)) {
        throw new Error(`canonical candidate drift for ${key}`);
      }
      const historicalRpc = refreshableProposal && existing.sourceKind === 'nouns-subgraph'
        && ['nouns-governor-logs', 'nouns-rpc'].includes(raw.sourceKind)
        && raw.daoId === 'nouns' && raw.sourceId === 'nouns-subgraph';
      if (historicalRpc) {
        if (String(raw.proposalId) !== String(existing.proposalId)
            || String(raw.externalId) !== String(existing.externalId)
            || BigInt(raw.blockNumber) < BigInt(existing.blockNumber)
            || BigInt(raw.observedHead) < BigInt(existing.observedHead)) return false;
        if (immutableEventMaterial(existing) !== immutableEventMaterial(raw)) {
          throw new Error(`canonical event drift for ${key}`);
        }
        return false;
      }
      const sameMaterial = refreshableProposal
        ? immutableEventMaterial(existing) === immutableEventMaterial(raw)
        : refreshableCandidate || canonicalMaterial(existing) === canonicalMaterial(raw);
      if (!sameMaterial) throw new Error(`canonical event drift for ${key}`);
      if (refreshableProposal || refreshableCandidate) {
        // A finalized snapshot may be replaced at the same height after a reorg,
        // but an older block/head can never make canonical state look fresh.
        if (BigInt(raw.blockNumber) < BigInt(existing.blockNumber)
          || BigInt(raw.observedHead) < BigInt(existing.observedHead)) return false;
        this.rawRecords[existingIndex] = { ...raw, ingestedAt: new Date(this.clock()).toISOString() };
      }
      if (record.proposal) this.upsertProposal(record.proposal);
      if (record.target) this.upsertTarget(record.target);
      if (record.vote) this.insertVote(record.vote);
      if (record.delegation) this.insertDelegation(record.delegation);
      return false;
    }
    this._keys.add(`r:${key}`); this.rawRecords.push({ ...raw, ingestedAt: new Date(this.clock()).toISOString() });
    if (record.proposal) this.upsertProposal(record.proposal);
    if (record.target) this.upsertTarget(record.target);
    if (record.vote) this.insertVote(record.vote);
    if (record.delegation) this.insertDelegation(record.delegation);
    return true;
  }
  reconcileRange({ daoId, sourceId, fromBlock, toBlock, records }) {
    const incoming = new Map(records.map((record) => { const row = sanitizeProvenance({ ...record.raw, proposalId: record.raw.proposalId || record.proposal?.proposalId || record.vote?.proposalId || null, contentHash: record.raw.contentHash || record.proposal?.contentHash || null }); return [eventKey(row), row]; }));
    for (const existing of this.rawRecords) { const next = incoming.get(eventKey(existing)); if (next && immutableEventMaterial(existing) !== immutableEventMaterial(next)) throw new Error(`canonical event drift for ${eventKey(existing)}`); }
    const movedKeys = new Set(this.rawRecords.filter((row) => { const next = incoming.get(eventKey(row)); return next && (String(row.blockNumber) !== String(next.blockNumber) || (row.blockHash || null) !== (next.blockHash || null)); }).map(eventKey));
    const inRange = (row) => row.daoId === daoId && row.sourceId === sourceId && !(row.recordType === "proposal" && row.sourceRecordKey) && ((BigInt(row.blockNumber) >= BigInt(fromBlock) && BigInt(row.blockNumber) <= BigInt(toBlock)) || movedKeys.has(eventKey(row)));
    const removed = this.rawRecords.filter(inRange); const removedKeys = new Set(removed.map(eventKey));
    const removedChainKeys = new Set(removed.filter((row) => row.transactionHash != null && row.logIndex != null).map(chainEventKey));
    const removedSourceKeys = new Set(removed.filter((row) => row.sourceRecordKey).map(eventKey));
    this.rawRecords = this.rawRecords.filter((row) => !inRange(row));
    this.voteEvents = this.voteEvents.filter((row) => !removedSourceKeys.has(eventKey(row)) && !removedChainKeys.has(chainEventKey(row)));
    this.delegationEvents = this.delegationEvents.filter((row) => !removedChainKeys.has(chainEventKey(row)));
    const proposalIds = new Set(removed.filter((row) => row.recordType === "proposal" && row.proposalId).map((row) => row.proposalId));
    for (const id of proposalIds) if (!this.rawRecords.some((row) => row.daoId === daoId && row.recordType === "proposal" && row.proposalId === id)) {
      this.proposals = this.proposals.filter((row) => !(row.daoId === daoId && row.proposalId === id));
      this.proposalActions = this.proposalActions.filter((row) => !(row.daoId === daoId && row.proposalId === id));
    }
    for (const key of removedKeys) this._keys.delete(`r:${key}`);
    for (const key of removedSourceKeys) this._keys.delete(`v:${key}`);
    for (const prefix of ["v", "d"]) for (const key of removedChainKeys) this._keys.delete(`${prefix}:${key}`);
  }
  reconcileRpcProposals({ daoId, sourceId, fromBlock, toBlock, cutoverBlock, createdIds }) {
    if (daoId !== 'nouns' || sourceId !== 'nouns-subgraph'
        || ![fromBlock, toBlock].every((n) => Number.isSafeInteger(n) && n >= 0)
        || fromBlock > toBlock || (cutoverBlock != null && (!Number.isSafeInteger(cutoverBlock) || cutoverBlock < 0))
        || !Array.isArray(createdIds) || !createdIds.every((id) => /^(0|[1-9][0-9]*)$/.test(String(id)))) {
      throw new TypeError('invalid RPC proposal reconciliation range');
    }
    const present = new Set(createdIds.map(String));
    const removed = this.rawRecords.filter((row) => {
      if (row.daoId !== daoId || row.sourceId !== sourceId || row.recordType !== 'proposal'
          || row.sourceRecordKey !== `proposal:${row.proposalId}`
          || !['nouns-governor-logs', 'nouns-rpc'].includes(row.sourceKind)
          || !/^(0|[1-9][0-9]*)$/.test(String(row.payload?.createdBlock ?? ''))) return false;
      const created = BigInt(row.payload.createdBlock);
      return created >= BigInt(fromBlock) && created <= BigInt(toBlock)
        && created >= BigInt(cutoverBlock ?? fromBlock) && !present.has(String(row.proposalId));
    });
    const keys = new Set(removed.map(eventKey));
    this.rawRecords = this.rawRecords.filter((row) => !keys.has(eventKey(row)));
    for (const row of removed) {
      this._keys.delete(`r:${eventKey(row)}`);
      if (!this.rawRecords.some((other) => other.daoId === daoId && other.sourceId === sourceId
          && other.recordType === 'proposal' && String(other.proposalId) === String(row.proposalId))) {
        this.proposalRefreshes.delete(`${daoId}:${sourceId}:${row.proposalId}`);
      }
      if (!this.rawRecords.some((other) => other.daoId === daoId && other.recordType === 'proposal'
          && String(other.proposalId) === String(row.proposalId))) {
        this.proposals = this.proposals.filter((proposal) => !(proposal.daoId === daoId && String(proposal.proposalId) === String(row.proposalId)));
        this.proposalActions = this.proposalActions.filter((action) => !(action.daoId === daoId && String(action.proposalId) === String(row.proposalId)));
      }
    }
  }
  reconcileProposals({ daoId, sourceId, records }) {
    const incoming = new Map(records.map((record) => [eventKey(record.raw), sanitizeProvenance({ ...record.raw, proposalId: record.raw.proposalId || record.proposal?.proposalId || null, contentHash: record.raw.contentHash || record.proposal?.contentHash || null })]));
    const existing = this.rawRecords.filter((row) => row.daoId === daoId && row.sourceId === sourceId && row.recordType === "proposal" && row.sourceRecordKey);
    for (const row of existing) { const next = incoming.get(eventKey(row)); if (next && immutableEventMaterial(row) !== immutableEventMaterial(next)) throw new Error(`canonical event drift for ${eventKey(row)}`); }
    const orphans = existing.filter((row) => !incoming.has(eventKey(row)));
    const orphanKeys = new Set(orphans.map(eventKey));
    this.rawRecords = this.rawRecords.filter((row) => !orphanKeys.has(eventKey(row)));
    for (const row of orphans) {
      this._keys.delete(`r:${eventKey(row)}`);
      if (!this.rawRecords.some((candidate) => candidate.daoId === daoId && candidate.recordType === "proposal" && candidate.proposalId === row.proposalId)) {
        this.proposals = this.proposals.filter((proposal) => !(proposal.daoId === daoId && proposal.proposalId === row.proposalId));
        this.proposalActions = this.proposalActions.filter((action) => !(action.daoId === daoId && action.proposalId === row.proposalId));
      }
    }
  }
  reconcileCandidates({ daoId, sourceId, records }) {
    const incoming = new Map(records.map((record) => [eventKey(record.raw), canonicalCandidateTarget(record.target)]));
    const existing = this.rawRecords.filter((row) => row.daoId === daoId && row.sourceId === sourceId
      && row.recordType === "proposal_candidate" && row.sourceRecordKey);
    const orphans = existing.filter((row) => !incoming.has(eventKey(row)));
    const orphanKeys = new Set(orphans.map(eventKey));
    this.rawRecords = this.rawRecords.filter((row) => !orphanKeys.has(eventKey(row)));
    for (const row of orphans) {
      this._keys.delete(`r:${eventKey(row)}`);
      this.targets.delete(`${daoId}:${row.sourceRecordKey}`);
    }
  }
  getProposalSyncContext(daoId, options = {}) {
    const rows = this.proposals.filter((row) => row.daoId === daoId);
    const maxProposalId = rows.reduce((max, row) => (max == null || BigInt(row.proposalId) > BigInt(max) ? row.proposalId : max), null);
    const warmAfterMs = Number(options.warmRefreshIntervalMs ?? DEFAULT_WARM_REFRESH_MS);
    const now = Number(options.now ?? Date.now());
    const refreshProposals = rows
      .filter((row) => {
        const trackingState = row.trackingState || trackingStateFor(row.effectiveStatus || row.normalized?.outcome);
        if (trackingState === TrackingState.FINAL) return false;
        if (trackingState === TrackingState.HOT) return true;
        const age = now - new Date(row.updatedAt || 0).getTime();
        return !Number.isFinite(age) || age >= warmAfterMs;
      })
      .sort((a, b) => (BigInt(a.proposalId) < BigInt(b.proposalId) ? -1 : 1))
      .map((row) => ({
        proposalId: row.proposalId,
        contentHash: row.contentHash,
        normalized: row.normalized,
        trackingState: row.trackingState || null,
        effectiveStatus: row.effectiveStatus || null,
        lastObservedBlock: row.lastObservedBlock ?? null,
        updatedAt: row.updatedAt || null,
      }));
    return { maxProposalId, refreshProposals };
  }

  trackingCounts() {
    const counts = new Map();
    for (const row of this.proposals) {
      const trackingState = row.trackingState || trackingStateFor(row.effectiveStatus || row.normalized?.outcome);
      const key = `${row.daoId}:${trackingState}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
      const [daoId, trackingState] = key.split(":");
      return { daoId, trackingState, count };
    });
  }

  async listDaos() { return [...this.daos.values()].sort((a,b) => a.id.localeCompare(b.id)); }
  async getDao(id) { return this.daos.get(id) || null; }
  async getProposal(daoId, proposalId) {
    const row = this.proposals.find((x) => x.daoId === daoId && x.proposalId === proposalId);
    return row ? proposalRead(row) : null;
  }
  async getGateProposal(daoId, proposalId) {
    const proposal = this.proposals.find((row) => row.daoId === daoId && row.proposalId === proposalId);
    if (!proposal) return null;
    const rawProvenance = this.rawRecords
      .filter((row) => row.daoId === daoId && row.proposalId === proposalId && row.recordType === "proposal"
        && row.sourceId === "nouns-subgraph" && row.sourceRecordKey === `proposal:${proposalId}`
        && row.contentHash === proposal.contentHash && row.blockHash && row.ingestedAt);
    const refresh = this.proposalRefreshes.get(`${daoId}:nouns-subgraph:${proposalId}`);
    const provenance = [...rawProvenance, ...(refresh && refresh.contentHash === proposal.contentHash
      && refresh.payload.description === proposal.normalized?.description ? [refresh] : [])]
      .sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? 1 : -1)[0];
    if (!provenance) return null;
    return {
      chainId: DAO_CONFIGS[daoId].chainId,
      governorAddress: DAO_CONFIGS[daoId].currentGovernor,
      proposalId,
      title: proposal.normalized?.title,
      proposer: proposal.normalized?.proposer,
      refreshedAt: provenance.ingestedAt,
      sourceBlock: String(provenance.blockNumber),
      sourceBlockHash: provenance.blockHash,
      effectiveStatus: presentProposal(proposal.normalized, proposal).effectiveStatus,
      contentHash: `0x${String(proposal.contentHash).replace(/^0x/, "")}`,
      actions: canonicalGateActions(this.proposalActions
        .filter((row) => row.daoId === daoId && row.proposalId === proposalId)
        .sort((a, b) => (a.actionIndex ?? a.index) - (b.actionIndex ?? b.index))
        .map(({ index, actionIndex, target, valueWei, signature, calldata }) => ({
          actionIndex: actionIndex ?? index,
          target, valueWei: String(valueWei), signature: signature || "", calldata,
        }))),
    };
  }
  async getGateTarget(daoId, targetId) {
    if (String(targetId).startsWith("proposal:")) return this.getGateProposal(daoId, String(targetId).slice(9));
    const target = this.targets.get(`${daoId}:${targetId}`);
    if (!target) return null;
    const provenance = this.rawRecords.filter((row) => row.daoId === daoId && row.recordType === "proposal_candidate"
      && row.sourceId === "nouns-subgraph" && row.sourceRecordKey === targetId && row.blockHash && row.ingestedAt)
      .sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? 1 : -1)[0];
    if (!provenance || provenance.contentHash !== String(target.contentHash).replace(/^0x/, "")) return null;
    return { ...structuredClone(target), refreshedAt: provenance.ingestedAt, sourceBlock: String(provenance.blockNumber), sourceBlockHash: provenance.blockHash };
  }
  async listProposals({ daoId, limit, cursor }) {
    const decoded = typeof cursor === "string" && !/^\d+$/.test(cursor) ? decodeProposalCursor(cursor) : cursor;
    let rows = this.proposals.filter((x) => x.daoId === daoId).sort((a,b) => BigInt(a.proposalId) < BigInt(b.proposalId) ? 1 : -1);
    if (decoded) rows = rows.filter((x) => BigInt(x.proposalId) < BigInt(decoded));
    const selected = rows.slice(0, limit);
    return {
      items: selected.map(proposalRead),
      nextCursor: rows.length > limit ? encodeProposalCursor(selected.at(-1).proposalId) : null,
    };
  }
  async listVotes({ daoId, voter, limit, cursor }) {
    const decoded = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
    let rows = this.voteEvents.filter((x) => x.daoId === daoId && (!voter || x.voter.toLowerCase() === voter.toLowerCase())).sort(compareCursor);
    if (decoded) rows = rows.filter((x) => compareCursor(x, decoded) > 0);
    const items = rows.slice(0, limit); return { items, nextCursor: rows.length > limit ? encodeCursor(items.at(-1)) : null };
  }
  async status() { return { daos: this.daos.size, proposals: this.proposals.length, votes: this.voteEvents.length, delegations: this.delegationEvents.length, tracking: this.trackingCounts(), checkpoints: [...this.checkpoints.values()] }; }
  async syncStatus(daoId) { return [...this.checkpoints.values()].filter((x) => x.daoId === daoId); }
}
module.exports = { MemoryGovernanceStore, eventKey, encodeCursor, decodeCursor, encodeProposalCursor, decodeProposalCursor };
