# Contributor rules

- Read the source, tests, migrations, and call sites before changing behavior.
- Canonical governance identity and source provenance fail closed when ambiguous.
- Never advance a checkpoint after incomplete indexing; persist it with successful writes.
- Isolate DAO state and failures. One DAO failure must not corrupt another DAO.
- Prefer end-to-end and PostgreSQL integration tests for indexing behavior; mocks alone do not establish database semantics.
- Preserve exact incident regressions: snapshot integrity, ENS historical event hashes, failure isolation, in-process recovery, monotonic checkpoints, and redaction.
- Never log credentials or raw sensitive endpoint data.
- Ordinary development must not mutate production systems. Schema changes require explicit review and migration compatibility analysis.
- Preserve API response shapes unless deliberately versioned and reviewed.
- Verify Node 20 and 22, clean `npm ci`, PostgreSQL tests, and the final diff before release.
