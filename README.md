# Governance Indexer

Standalone PostgreSQL-backed indexer and read-only API for canonical Nouns, ENS, and Railgun Ethereum governance data. It owns source adapters, proposal/candidate normalization, checkpoints, storage, API, and health reporting. Gavel remains an API consumer; its client and product integrations are not included here.

## Runtime and local setup

Requires Node.js 20 or newer and PostgreSQL 15+ (CI uses PostgreSQL 16). Set `DATABASE_URL` for an indexer DB. Use a disposable local database for migrations and integration tests. No production RPC credentials are needed for deterministic tests.

```sh
npm ci
export DATABASE_URL='postgres://localhost/governance_indexer'
npm run indexer -- migrate
npm run indexer -- sync --all
npm run indexer -- status
npm run indexer -- serve
curl -fsS http://localhost:8080/health
```

For one DAO: `npm run indexer -- sync --dao nouns|ens|railgun-eth`. Run full enumeration with `backfill --dao <dao>` or `sync --dao <dao> --full`. Run all configured DAOs with `sync --all`; defaults are `nouns,ens`.

## Environment

- `DATABASE_URL` or libpq `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- `ETHEREUM_RPC_URL` — required when enabled DAOs need canonical Ethereum block provenance
- `INDEXER_ENABLED_DAOS` — comma-separated IDs, default `nouns,ens`
- `INDEXER_CONFIRMATION_DEPTH` — default 64
- `INDEXER_BLOCK_BATCH_SIZE` — default 5000; ENS may override via `ENS_PROPOSAL_BLOCK_BATCH_SIZE`
- `INDEXER_RPC_CONCURRENCY` (4), `INDEXER_DB_POOL_SIZE` (10)
- `INDEXER_FULL_SCAN_INTERVAL_SECONDS` (21600), `INDEXER_WARM_REFRESH_SECONDS` (900)
- `INDEXER_MAX_CHECKPOINT_AGE_SECONDS` (900), `API_HOST` (`0.0.0.0`), `API_PORT` (8080), `LOG_LEVEL` (`info`)
- `RAILGUN_FROM_BLOCK` optionally overrides the verified default (15505853)
- `NOUNS_SUBGRAPH_URL`, `PUBLIC_SOURCE_ENDPOINT`

Keep credentials in an external environment/secret manager. Never commit `.env` files or place credentials in endpoint URLs.

## Persistence and health

Migrations `001_initial.sql` through `004_nouns_candidates.sql` are exclusively indexer-owned. `migrate` initializes a fresh database; `docker/init-db.sh` provisions least-privilege `gavel_indexer` and read-only `gavel_api` roles on a fresh Postgres volume. Checkpoints advance transactionally with successful indexing and monotonically. Failed attempts preserve progress and record redacted `lastError`. `updatedAt` tracks attempts more closely than successful progress; a future `last_success_at` is tracked in the roadmap.

`/health` is liveness only. CLI `health` reports missing, stale, or failed enabled DAO checkpoints. A thrown error for one DAO does not stop safe later DAOs; the cycle still fails overall and the failed DAO remains unhealthy. A hung DAO can still block later DAOs (known follow-up).

## Tests

```sh
npm test
GAVEL_TEST_DATABASE_URL='postgres://localhost/governance_indexer_test' npm run test:postgres
npm run test:domain
```

PostgreSQL tests are destructive to their configured test database: use a dedicated disposable database only. The deterministic suite uses fixtures and does not require live chain credentials.

## Docker and releases

Build locally with `docker build -t governance-indexer:local .`; run only against a disposable local DB. Docker image publishing is not configured yet. The intended release is CI-built immutable GHCR tags `ghcr.io/jgramajo4/governance-indexer:<full-commit-sha>`, deployed and rolled back by exact image digest/tag after review. No production deployment is performed by this repository's CI.

See [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [adding a DAO](docs/ADDING_A_DAO.md), [deployment](docs/DEPLOYMENT.md), [roadmap](docs/ROADMAP.md), and [Gavel decoupling](docs/GAVEL_DECOUPLING.md).

Canonical import source: Gavel `42edbb49aa13e76be1488f94f6717ca6557447c2` (includes incident worker fix `b2925efa53d4ba12fb8019067d3a4d8ee77d873f`; worker implementation matches production hotfix `a445f340f0553d5b43b4207c610f9583763689c3`). Later reviewed API/proposal identity changes from current main are included.
