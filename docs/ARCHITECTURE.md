# Architecture

The CLI runner composes a per-DAO source, a `GovernanceSyncWorker`, and a PostgreSQL store. Sources normalize canonical proposal/vote/candidate data; the worker serializes each source attempt, applies lifecycle derivation, commits data and checkpoints transactionally, and aggregates DAO errors after peers run. The read-only HTTP API reads from the same authoritative DB.

`src/domain/` contains governance-owned canonical logic: proposal identity, Nouns candidate ID/lifecycle, proposal lifecycle, RPC block-range rules, proposal/vote schemas, and the Nouns normalization subset. `src/ens-reconcile.js` and `src/railgun-proposal.js` retain only indexing/reconciliation RPC behavior from the former application adapters. No Gate, TUI, Bankr, or Gavel workspace runtime is required.

PostgreSQL owns canonical persistence: migrations 001–004 define only governance-index tables and role grants. Each `(dao_id, source_id)` checkpoint is advanced in the same transaction as committed ingestion. DAO data/checkpoints are isolated by identity and source locks.

API liveness (`/health`) is distinct from index readiness (`governance-indexer health`). A failure thrown by one DAO does not prevent attempts for later DAOs; cycle-level failure remains visible. Hung RPC calls can still block the sequential worker.

Future calendar events should be projections of canonical stored proposal lifecycle and source events, not a parallel scraper.
