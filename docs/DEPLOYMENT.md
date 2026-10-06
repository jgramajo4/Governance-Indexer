# Deployment

No deployment workflow or production mutation is configured here. Local setup/test requirements are in the root README.

Planned immutable release path: reviewed PR merge → CI test Node 20/22 and PostgreSQL 16 → build container from repository-only Dockerfile → publish `ghcr.io/jgramajo4/governance-indexer:<full-git-sha>` with provenance → review deployment change → Terra pulls exact SHA and recreates service → smoke-test API/status → retain previous SHA for rollback. Do not use mutable `latest` as production identity. GHCR publishing requires explicit workflow permissions and package authorization; configure them before enabling publishing.

The image must be built from this repository alone, run as non-root, and expose API port 8080. Runtime secrets are supplied externally; no production credentials or dirty source checkout belong in the image. Docker is not installed in the current extraction environment, so image build/start/smoke remains a required external gate.

Schema migrations are not automatically run by image startup; review and explicitly schedule migration execution before an application version requiring a new schema. This extraction makes no DB or Terra changes.

## CORS-only API handoff (instructions, not authorization)

This change adds no migration and changes no index worker, checkpoint, adapter, schema, or Compose file. Sysadmin must use the **reviewed and merged Forgejo SHA**, not this PR's unmerged head, for a replacement API image. On a clean checkout at that SHA, verify `git status --porcelain` is empty and `git rev-parse HEAD` equals the approved SHA, then build using the repository-only Dockerfile:

```sh
SHA=<approved-full-Forgejo-main-SHA>
docker build --build-arg VCS_REF="$SHA" -t "governance-indexer-api:$SHA" .
docker image inspect "governance-indexer-api:$SHA" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Record the **new image ID** and label (`SHA` must match), plus the **currently running API image ID** from `docker inspect gavel-index-api-1 --format '{{.Image}}'` and its current image reference for rollback. Keep that old image locally. A SHA-named tag alone is mutable: use a registry `name@sha256:<digest>` when available; otherwise pin/verify the local image ID before and after recreation and set `pull_policy: never` in the final API override. Do not tag or recreate the indexer/worker image. Do not run `migrate` for this change.

On Terra, the running API container's `com.docker.compose.project.config_files` label must be read again before any approved deployment; the observed ordering at authoring time was:

```text
/srv/docker/gavel-index/docker-compose.yml
/srv/docker/gavel-index-runtime.yml
/srv/docker/gavel-index-varlock-pilot/compose.yml
/srv/docker/gavel-index-varlock-runtime/transition-20260927/compose.yml
/srv/docker/gavel-index-varlock-runtime/bitwarden-20260927.yml
/srv/docker/gavel-index-varlock-runtime/transition-20260927/host-network.yml
/srv/docker/gavel-index-varlock-runtime/standalone-265324f75d763b468b30cd647ffdf8b55cd14739/compose.yml
/srv/docker/gavel-index-varlock-runtime/standalone-265324f75d763b468b30cd647ffdf8b55cd14739/api-compose.yml
```

The final existing overlay selects `api` image `governance-indexer-api:265324f75d763b468b30cd647ffdf8b55cd14739`; the runtime overlay sets `127.0.0.1:18080:8080`, and the API has the `gavel-index_database` and `gavel-index-egress` networks. Preserve all eight files **in that order**, then add one host-local final API-only override (outside this source repo), with no modifications to the existing files:

```yaml
services:
  api:
    image: governance-indexer-api:<approved-full-Forgejo-main-SHA> # or immutable registry digest
    pull_policy: never # for a local image; use digest-specific pull policy for a registry image
    environment:
      GAVEL_INDEX_CORS_ORIGINS: https://gavel.0773h.com
```

The exact non-secret setting is `GAVEL_INDEX_CORS_ORIGINS=https://gavel.0773h.com`. Keep the existing DB/secret settings and network/port overrides intact. With the same Compose project (`gavel-index`) and all eight existing `-f` files in their current order plus the final override as the **last** `-f`, Sysadmin may run `docker compose -p gavel-index <ordered -f arguments> -f <final-api-override> up -d --no-deps --no-build --force-recreate api` **only after approval**. `--no-deps` avoids recreating the `migrate` dependency and the database; do not use `down`, `up` without a service, or `--build`. First verify effective service keys without printing secret values; never dump `docker compose config` or `.env` contents. Read back the API image ID, revision label, ports, networks and container health; smoke-test allowed, denied, preflight, and no-Origin requests against `http://127.0.0.1:18080`, plus the public route after edge policy review. Check that PostgreSQL and indexer container IDs/checkpoints did not change.

Rollback: restore the final API-only override to the **retained previous image reference/ID**, remove the CORS setting from that override (the previous source does not implement it), then repeat the same API-only `up -d --no-deps --no-build --force-recreate api` and read back the previous image ID and health. Preserve DB/worker/volume/checkpoint state; no migration reversal is needed. A Cloudflare cache that ignores `Vary: Origin` needs an explicit edge review before deployment; this PR does not change Cloudflare or caching policy.
