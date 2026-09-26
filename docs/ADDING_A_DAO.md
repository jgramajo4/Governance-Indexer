# Adding a DAO

1. Add explicit DAO/source configuration: stable DAO ID, chain ID, governor/contract identity, source ID/kind, verified start block and public endpoint provenance. Never infer identity from display names.
2. Implement a source consumed by `GovernanceSyncWorker`: canonical head/finality, `fetchVotes`, proposal enumeration/materialization as applicable, and stable source record keys. A `fetchProposals` method currently opts a source into proposal enumeration; method-presence semantics are implicit and must be documented in the adapter.
3. Preserve source semantics. Nouns proposal/candidate enumeration is pinned to one snapshot and fails closed if height/hash diverge or metadata is invalid. ENS ProposalCreated records from separate historical blocks are individually valid; do not compare their block hashes as one pinned snapshot.
4. Define canonical identity `(dao, chainId, governorAddress, proposalId)` and reject ambiguous/mismatched IDs. Use the existing proposal identity validation. Vote/candidate identities and content hashes must remain stable across replay.
5. Implement incremental range replay, overlap/reorg handling, and full refresh. Advance checkpoints only atomically with successful data writes and never backwards. Failed sync retains prior progress and exposes redacted error state.
6. Register the adapter in `src/config.js` and `bin/gavel-indexer.js`; keep DAO/source boundaries independent.
7. Add realistic fixtures and tests: normalization, malformed data, provider failure, retry/replay, checkpoint monotonicity, full refresh, health and API contract. Use PostgreSQL tests for persistence/locks/transactions, not mocks alone.
8. If the adapter emits one pinned snapshot, explicitly preserve the shared height/hash invariant. Do not use an event's historical inclusion block hash as snapshot provenance. A future explicit source capability model should replace current method-presence inference; do not silently add new inferred capabilities.
