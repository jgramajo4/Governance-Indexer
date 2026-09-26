# Gavel decoupling follow-up

Do not remove the Gavel copy in this extraction. After standalone behavior and production cutover are independently verified, a later Gavel PR should delete worker, adapters, stores, migrations, runner and API implementation while retaining HTTP consumers.

Current reverse dependencies observed on Gavel `42edbb49aa13e76be1488f94f6717ca6557447c2`:

- `packages/server/src/gate/index-client.js` imports `packages/governance-index/src/gate-action.js` and directly uses the index Postgres store/API paths for index facts. Migrate it to the public read-only API/client contract before removing those internals.
- `packages/server/test/gate-role-wiring.test.js` imports `roles.js` and `postgres-store.js`, and reads index DB init/store source. Replace with isolated indexer DB contract/integration tests or API-level Gate consumer tests.
- `packages/server/test/gate-store.test.js` and `packages/server/test/profile-api.test.js` import indexer init/API/memory store. Move assertions to Gate-owned API boundary or remove only after equivalent consumer contract tests exist.
- `packages/cli/bin/gavel.js` consumes `IndexApiClient` from the indexer package. Retain/move that client into Gavel-owned consumer code; it is intentionally absent here.
- `packages/tui/src/data/governanceIndex.ts`, `packages/tui/src/constants.ts`, `integrations/bankr/src/index-api.js`, and Hermes scripts are consumers; keep their HTTP behavior and endpoint configuration in Gavel.
- Gavel root package scripts, Docker/Compose, tests, and `.env.example` currently reference the in-repo worker paths; update these only in the later cleanup PR.

Removal blockers: production must be switched to an immutable standalone image; API compatibility and health/readiness verified; Gate narrow reads must use stable API shapes rather than index DB internals; Gavel CLI/TUI/Bankr/Hermes consumer contract tests must pass against the external API. Preserve old implementation until that later PR is independently reviewed.
