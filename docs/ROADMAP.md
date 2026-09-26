# Roadmap

- Add governance DAOs with isolated adapters and source-specific regression coverage.
- Build a governance calendar from canonical indexed lifecycle events: proposal creation, voting start/end, grace/queue period, execution eligibility, execution, cancellation, and veto where supported.
- Introduce an explicit source capability model; replace method-presence inference for snapshot semantics and proposal enumeration.
- Add `last_success_at`; current `updatedAt` is closer to last attempt than last successful progress.
- Add per-DAO timeout/hang isolation; a thrown error is isolated today, but a source that hangs can block later sequential peers.
- Add optional signals/enrichment with provenance and clear canonical-vs-derived boundaries.
- Evaluate optional x402 API access without changing current unauthenticated read contract.
