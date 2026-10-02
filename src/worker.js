const { DAO_CONFIGS } = require("./config");
const { redactErrorMessage } = require("./redaction");
const { applyGovernanceLifecycle, TrackingState } = require("./domain/lifecycle");
const { DEFAULT_LOG_BLOCK_BATCH_SIZE, blockRanges, parseBlockBatchSize } = require("./domain/block-range");

const DEFAULT_WARM_REFRESH_MS = 15 * 60 * 1000;

class GovernanceSyncWorker {
  constructor({ store, sources, batchSize = DEFAULT_LOG_BLOCK_BATCH_SIZE, concurrency = 4, retries = 3, fullScanIntervalMs = 6 * 60 * 60 * 1000, warmRefreshIntervalMs = DEFAULT_WARM_REFRESH_MS, logger = null }) { this.store = store; this.sources = sources; this.batchSize = parseBlockBatchSize(batchSize, "batchSize"); this.concurrency = concurrency; this.retries = retries; this.fullScanIntervalMs = Number(fullScanIntervalMs); this.warmRefreshIntervalMs = Number(warmRefreshIntervalMs); this.logger = logger || { info() {}, warn() {}, error() {} }; if (!store) throw new TypeError("store is required"); if (!Number.isFinite(this.fullScanIntervalMs) || this.fullScanIntervalMs < 0) throw new RangeError("fullScanIntervalMs must be a non-negative number"); if (!Number.isFinite(this.warmRefreshIntervalMs) || this.warmRefreshIntervalMs < 0) throw new RangeError("warmRefreshIntervalMs must be a non-negative number"); }
  async syncDao(daoId, options = {}) {
    const source = this.sources[daoId]; if (!source) throw new Error(`No source configured for ${daoId}`);
    const run = async () => {
      try { return await this._syncDao(daoId, source, options); }
      catch (error) {
        await this._recordDaoFailure(daoId, source, error);
        throw error;
      }
    };
    return this.store.withSourceLock ? this.store.withSourceLock(daoId, source.id, run) : run();
  }
  async _recordDaoFailure(daoId, source, error) {
    const safeError = redactErrorMessage(error);
    try {
      const checkpoint = await this.store.getCheckpoint(daoId, source.id);
      // A fresh RPC source has no committed cutover marker yet. Creating a
      // failure-only checkpoint would make every subsequent attempt fail closed.
      if (!checkpoint && daoId === "nouns" && source.id === "nouns-subgraph"
          && source.config.source.kind === "nouns-rpc") return;
      await this.store.transaction(async (tx) => tx.setCheckpoint({
        daoId,
        sourceId: source.id,
        nextBlock: checkpoint?.nextBlock ?? source.fromBlock,
        finalizedHead: checkpoint?.finalizedHead ?? Math.max(0, Number(source.fromBlock) - 1),
        updatedAt: new Date().toISOString(),
        lastError: safeError,
      }));
    } catch (checkpointError) {
      this.logger.error({ event: "checkpoint_error_failed", dao: daoId, error: redactErrorMessage(checkpointError) });
    }
  }
  _shouldFullScan(checkpoint, options) {
    if (options.fullProposalScan != null) return Boolean(options.fullProposalScan);
    if (!checkpoint || options.fromBlock != null) return true;
    if (!checkpoint.lastFullScanAt) return true;
    const age = Date.now() - new Date(checkpoint.lastFullScanAt).getTime();
    return !Number.isFinite(age) || age >= this.fullScanIntervalMs;
  }

  /**
   * The single canonical derivation point. Every proposal the indexer is about
   * to persist passes through here, whichever path produced it: incremental
   * discovery, incremental refresh, or full enumeration. Sources report; only
   * this decides what Gavel believes and how closely it keeps watching.
   */
  _deriveProposal(proposal, finalizedBlock) {
    if (!proposal?.normalized) return proposal;
    return {
      ...proposal,
      normalized: applyGovernanceLifecycle(proposal.normalized, { finalizedBlock }),
      lastObservedBlock: String(finalizedBlock),
    };
  }

  /**
   * Re-derives each candidate against the height its stored tallies were read
   * at, and terminalizes the ones that are canonically done without spending an
   * upstream request. In ordinary operation this is a no-op, because a proposal
   * refreshed past its deadline was already terminalized on write. It matters
   * after a restore, a migration, or an index written by an older build, where
   * it collapses a stale hot set on the first cycle instead of over hours of
   * upstream refreshes.
   */
  _planProposalRefresh(daoId, context) {
    const refreshProposals = [];
    const terminalized = [];
    for (const row of context.refreshProposals || []) {
      const observedBlock = row.lastObservedBlock;
      const derived = observedBlock == null || !row.normalized
        ? null
        : applyGovernanceLifecycle(row.normalized, { finalizedBlock: observedBlock });
      if (derived?.trackingState === TrackingState.FINAL) {
        terminalized.push({ daoId, proposalId: row.proposalId, contentHash: row.contentHash, normalized: derived, lastObservedBlock: String(observedBlock) });
      } else {
        refreshProposals.push(row);
      }
    }
    return { ...context, refreshProposals, terminalized };
  }

  async _proposalContext(daoId, full) {
    if (full || typeof this.store.getProposalSyncContext !== "function") return { refreshProposals: [], maxProposalId: null, terminalized: [] };
    const context = await this.store.getProposalSyncContext(daoId, { warmRefreshIntervalMs: this.warmRefreshIntervalMs });
    return this._planProposalRefresh(daoId, context);
  }

  /**
   * One line per proposal whose canonical status moved, and never a line for the
   * immutable majority. A steady Nouns cycle therefore logs a handful of records,
   * not a few hundred.
   */
  _logLifecycleChange(daoId, previous, proposal, reason) {
    const next = proposal?.normalized;
    if (!next) return;
    if (previous && previous.effectiveStatus === next.effectiveStatus && previous.trackingState === next.trackingState) return;
    this.logger.info({
      event: next.trackingState === TrackingState.FINAL ? "proposal_finalized" : "proposal_lifecycle_changed",
      dao: daoId,
      proposalId: proposal.proposalId,
      sourceState: next.sourceState,
      effectiveStatus: next.effectiveStatus,
      trackingState: next.trackingState,
      previousEffectiveStatus: previous?.effectiveStatus ?? null,
      previousTrackingState: previous?.trackingState ?? null,
      lifecycleReason: next.lifecycleReason,
      refreshReason: reason,
    });
  }

  async _syncDao(daoId, source, options) {
    await this.store.transaction(async (tx) => {
      const config = DAO_CONFIGS[daoId];
      await tx.upsertDao({ ...config, fromBlock: source.fromBlock, updatedAt: new Date().toISOString() });
      await tx.upsertSource({ daoId, id: source.id, kind: source.config.source.kind, endpoint: source.rpcUrl || source.config.source.endpoint, publicEndpoint: source.publicEndpoint, fromBlock: source.fromBlock });
    });
    const checkpoint = await this.store.getCheckpoint(daoId, source.id);
    const cutoverBlock = daoId === "nouns" && source.id === "nouns-subgraph" && this.store.getRpcCutoverBlock
      ? await this.store.getRpcCutoverBlock(daoId, source.id) : null;
    if (daoId === "nouns" && source.id === "nouns-subgraph" && source.config.source.kind === "nouns-rpc") {
      if (cutoverBlock == null && checkpoint) throw new Error("Nouns RPC cutover marker is missing for existing checkpoint");
      source.cutoverBlock = cutoverBlock ?? source.fromBlock;
    } else if (cutoverBlock != null) source.cutoverBlock = cutoverBlock;
    if (daoId === "nouns" && source.id === "nouns-subgraph" && typeof source.hydrateCandidateCache === "function") {
      const stored = await this.store.getCandidateSnapshot(daoId, source.id);
      if (stored && (!checkpoint || Number(stored.checkpointBlock) > Number(checkpoint.finalizedHead))) {
        throw new Error("candidate snapshot exceeds committed checkpoint");
      }
      if (stored) source.hydrateCandidateCache(stored.snapshot);
    }
    const start = options.fromBlock == null ? (checkpoint ? Math.max(source.fromBlock, Number(checkpoint.nextBlock) - source.replayBlocks - 1) : source.fromBlock) : Math.max(source.fromBlock, Number(options.fromBlock));
    const finalHead = options.toBlock == null ? await source.head() : Number(options.toBlock);
    let batches = 0; let records = 0;
    const enumeratesProposals = typeof source.fetchProposals === "function";
    // A full enumeration is the only pass that may conclude a proposal has
    // disappeared, so it is also the only pass allowed to reconcile deletions.
    const full = this._shouldFullScan(checkpoint, options);
    // An RPC "full" pass cannot re-enumerate pre-cutover chain history. It still
    // needs the stored hot/warm refresh set, or open proposals with no new logs
    // would stop receiving pinned state/tally updates every scheduled full pass.
    const nounsRpc = daoId === "nouns" && source.id === "nouns-subgraph" && source.config.source.kind === "nouns-rpc";
    const proposalContext = { full, rpcCutoverBlock: cutoverBlock, ...(await this._proposalContext(daoId, full && !nounsRpc)) };
    if (nounsRpc) {
      proposalContext.loadProposal = (id) => this.store.getProposal(daoId, id);
    }
    const previousLifecycle = new Map((proposalContext.refreshProposals || []).map((row) => [String(row.proposalId), { effectiveStatus: row.effectiveStatus ?? row.normalized?.effectiveStatus ?? null, trackingState: row.trackingState ?? row.normalized?.trackingState ?? null }]));
    this.logger.info({ event: "proposal_refresh_plan", dao: daoId, source: source.id, mode: full ? "full" : "incremental", head: finalHead, upstreamRefresh: proposalContext.refreshProposals.length, locallyTerminalized: proposalContext.terminalized.length });
    // Terminalization is committed before any upstream call so a source outage
    // cannot keep a canonically dead proposal in the hot set.
    if (proposalContext.terminalized.length) await this.store.transaction(async (tx) => {
      for (const proposal of proposalContext.terminalized) {
        await tx.upsertProposal(proposal);
        this._logLifecycleChange(daoId, null, proposal, "stored_tallies_finalized");
      }
    });
    let fetchedProposals = [];
    let fetchedCandidates = [];
    try {
      fetchedProposals = enumeratesProposals ? await source.fetchProposals(start, finalHead, finalHead, proposalContext) : [];
      const enumeratesCandidates = typeof source.fetchCandidates === "function";
      fetchedCandidates = enumeratesCandidates ? await source.fetchCandidates(finalHead) : [];
      if (enumeratesProposals && enumeratesCandidates) {
        for (const [kind, rows] of [["proposal", fetchedProposals], ["candidate", fetchedCandidates]]) {
          const metadata = rows?.snapshot;
          if (!metadata || !Number.isSafeInteger(Number(metadata.blockNumber))
              || typeof metadata.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(metadata.blockHash)) {
            throw new Error(`canonical ${kind} snapshot metadata is required`);
          }
        }
        const snapshots = [fetchedProposals.snapshot, fetchedCandidates.snapshot];
        if (snapshots.some((snapshot) => Number(snapshot.blockNumber) !== finalHead)) throw new Error("canonical target snapshot height changed across reads");
        const snapshotHashes = new Set([
          ...snapshots.map((snapshot) => snapshot.blockHash),
          ...[...fetchedProposals, ...fetchedCandidates].map((row) => row?.raw?.blockHash),
        ].filter(Boolean));
        if (snapshotHashes.size > 1) throw new Error("canonical target snapshot hash changed across reads");
      }
    } catch (error) {
      const safeError = redactErrorMessage(error);
      this.logger.error({ event: "proposal_sync_failed", dao: daoId, source: source.id, error: safeError });
      throw error;
    }
    const proposalRecords = fetchedProposals.filter((row) => row?.raw);
    const materializedProposals = fetchedProposals.filter((row) => !row?.raw);
    for (const range of blockRanges(start, finalHead, this.batchSize)) {
      const { fromBlock: from, toBlock: to } = range;
      try {
        let logs; let attempt = 0;
        while (true) { try { logs = await source.fetchRange(from, to, finalHead); break; } catch (error) { if (++attempt >= this.retries) throw error; this.logger.warn({ event: "sync_retry", dao: daoId, source: source.id, fromBlock: from, toBlock: to, attempt, error: redactErrorMessage(error) }); await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1))); } }
        const normalized = [];
        for (let index = 0; index < logs.length; index += this.concurrency) normalized.push(...await Promise.all(logs.slice(index, index + this.concurrency).map((entry) => source.normalizeLog(entry, finalHead))));
        const canonicalRecords = normalized
          .filter((record) => cutoverBlock == null || BigInt(record.raw.blockNumber) >= BigInt(cutoverBlock))
          .map((record) => (record?.proposal ? { ...record, proposal: this._deriveProposal(record.proposal, finalHead) } : record));
        await this.store.transaction(async (tx) => {
          if (tx.reconcileRange) await tx.reconcileRange({ daoId, sourceId: source.id, fromBlock: from, toBlock: to, records: canonicalRecords, cutoverBlock });
          for (const row of canonicalRecords) if (await tx.ingest(row)) records += 1;
          if (!enumeratesProposals) await tx.setCheckpoint({ daoId, sourceId: source.id, nextBlock: to + 1, finalizedHead: finalHead, updatedAt: new Date().toISOString(), lastError: null });
        });
        batches += 1; this.logger.info({ event: "sync_batch", dao: daoId, source: source.id, fromBlock: from, toBlock: to, head: finalHead, fetched: logs.length, ingested: records, durationMs: 0 });
      } catch (error) {
        const safeError = redactErrorMessage(error);
        this.logger.error({ event: "sync_failed", dao: daoId, fromBlock: from, toBlock: to, error: safeError });
        throw error;
      }
    }
    // Replay canonical event placement first. Proposal enumeration is then the
    // authoritative finalized-head refresh for mutable state and tallies.
    if (enumeratesProposals) {
      try {
        await this.store.transaction(async (tx) => {
          if (nounsRpc) {
            if (!tx.reconcileRpcProposals) throw new Error("Nouns RPC proposal reconciliation is required");
            await tx.reconcileRpcProposals({ daoId, sourceId: source.id, fromBlock: start, toBlock: finalHead,
              cutoverBlock: source.cutoverBlock, createdIds: proposalRecords.map((row) => String(row.proposal.proposalId)) });
          }
          for (const proposal of materializedProposals) {
            const derived = this._deriveProposal(proposal.proposal || proposal, finalHead);
            if (daoId === "nouns" && source.id === "nouns-subgraph" && source.config.source.kind === "nouns-rpc") {
              await tx.refreshMaterializedProposal({ daoId, sourceId: source.id, proposalId: derived.proposalId,
                contentHash: derived.contentHash, snapshot: fetchedProposals.snapshot, payload: proposal.payload });
            }
            await tx.upsertProposal(derived);
            this._logLifecycleChange(daoId, previousLifecycle.get(String(derived.proposalId)), derived, full ? "full_enumeration" : "incremental_refresh");
          }
          const derivedRecords = proposalRecords.map((record) => ({ ...record, proposal: this._deriveProposal(record.proposal, finalHead) }));
          // Only a full enumeration is authoritative about which proposals exist.
          if (full && tx.reconcileProposals
              && !(daoId === "nouns" && source.id === "nouns-subgraph" && source.config.source.kind === "nouns-rpc")) {
            await tx.reconcileProposals({ daoId, sourceId: source.id, records: derivedRecords, cutoverBlock });
          }
          for (const row of derivedRecords) {
            if (await tx.ingest(row)) records += 1;
            this._logLifecycleChange(daoId, previousLifecycle.get(String(row.proposal?.proposalId)), row.proposal, full ? "full_enumeration" : "incremental_refresh");
          }
          if (tx.reconcileCandidates) await tx.reconcileCandidates({ daoId, sourceId: source.id, records: fetchedCandidates });
          for (const row of fetchedCandidates) if (await tx.ingest(row)) records += 1;
          if (daoId === "nouns" && source.id === "nouns-subgraph" && typeof source.exportCandidateCache === "function") {
            const snapshot = source.exportCandidateCache();
            if (snapshot) {
              if (snapshot.snapshot !== finalHead || snapshot.blockHash !== fetchedCandidates.snapshot?.blockHash) {
                throw new Error("candidate cache does not match fetched finalized snapshot");
              }
              await tx.setCandidateSnapshot({ daoId, sourceId: source.id, checkpointBlock: finalHead,
                checkpointHash: snapshot.blockHash, snapshot });
            }
          }
          if (daoId === "nouns" && source.id === "nouns-subgraph" && source.config.source.kind === "nouns-rpc"
              && cutoverBlock == null && !checkpoint) {
            await tx.freezeRpcCutoverBlock(daoId, source.id, source.fromBlock);
          }
          await tx.setCheckpoint({ daoId, sourceId: source.id, nextBlock: Math.max(finalHead + 1, Number(checkpoint?.nextBlock || 0)), finalizedHead: finalHead, updatedAt: new Date().toISOString(), ...(full ? { lastFullScanAt: new Date().toISOString() } : {}), lastError: null });
        });
      } catch (error) {
        throw error;
      }
    }
    return { ok: true, dao: daoId, fromBlock: start, toBlock: finalHead, batches, records, fullProposalScan: full, proposalsRefreshed: proposalRecords.length + materializedProposals.length, proposalsTerminalizedLocally: proposalContext.terminalized.length };
  }
  async syncAll(options = {}) {
    const results = [];
    const failures = [];
    for (const daoId of Object.keys(this.sources)) {
      try { results.push(await this.syncDao(daoId, options)); }
      catch (error) {
        failures.push({ daoId, error });
        this.logger.error({ event: "dao_sync_failed", dao: daoId, error: redactErrorMessage(error) });
      }
    }
    if (failures.length) {
      throw new AggregateError(failures.map(({ error }) => error), `DAO sync failed for: ${failures.map(({ daoId }) => daoId).join(", ")}`);
    }
    return results;
  }
}
module.exports = { GovernanceSyncWorker, DEFAULT_WARM_REFRESH_MS };
