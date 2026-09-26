# Deployment

No deployment workflow or production mutation is configured here. Local setup/test requirements are in the root README.

Planned immutable release path: reviewed PR merge → CI test Node 20/22 and PostgreSQL 16 → build container from repository-only Dockerfile → publish `ghcr.io/jgramajo4/governance-indexer:<full-git-sha>` with provenance → review deployment change → Terra pulls exact SHA and recreates service → smoke-test API/status → retain previous SHA for rollback. Do not use mutable `latest` as production identity. GHCR publishing requires explicit workflow permissions and package authorization; configure them before enabling publishing.

The image must be built from this repository alone, run as non-root, and expose API port 8080. Runtime secrets are supplied externally; no production credentials or dirty source checkout belong in the image. Docker is not installed in the current extraction environment, so image build/start/smoke remains a required external gate.

Schema migrations are not automatically run by image startup; review and explicitly schedule migration execution before an application version requiring a new schema. This extraction makes no DB or Terra changes.
