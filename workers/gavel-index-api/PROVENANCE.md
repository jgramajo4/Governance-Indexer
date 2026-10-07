# gavel-index-api import provenance

This directory imports the Cloudflare Worker that fronts `https://index.0773h.com`.
Before this import the source existed only as an **untracked** directory in a
local Gavel checkout (`/home/pi/workspace/gavel/workers/gavel-index-api/` on the
operator Pi). It had never been committed to `gramajo/gavel`,
`pallax/Governance-Indexer`, or any other Forgejo repository.

The import commit copies these six files byte-for-byte (`cp -p`) without changing them.
Only this `PROVENANCE.md` file was added. `node_modules/` and `.wrangler/tmp/` were not imported.

| File | sha256 | Local mtime (PDT) |
| --- | --- | --- |
| `src/index.js` | `2b6785ff5597ba8a27deb4213ee12ddb58a4deaf34d9715658a96ab1cdabe492` | 2026-09-06 22:11:38 |
| `test/index.test.js` | `0265b112e19c5e8479076349f6c2bb3afa01dc3852bd28c31dbbf0ae3e435dff` | 2026-09-06 22:11:25 |
| `README.md` | `0444a7578846bf1781f44f29141213da9ac98e502aa219c0c5010e7cbf27f98c` | 2026-09-06 20:56:21 |
| `wrangler.toml` | `b8b7d6c3934336da373fb34d3c1906229208102bc44dbab178c367730f2392f7` | 2026-09-06 19:46:38 |
| `package.json` | `19cc4f4fbc77e3d9d3a8144d2f34534d445b594514c1763fe662e30f367c170b` | 2026-09-06 19:42:15 |
| `package-lock.json` | `4ff73fead7d166e9c7dc112db2301414ba2f86be67320977bc3e93c1b36f9486` | 2026-09-06 19:47:03 |

## Evidence linking this source to the deployed Worker

- **Wrangler deploy logs.** The local log directory (`~/.config/.wrangler/logs`) records three
  `wrangler deploy` runs of `gavel-index-api` from this directory on 2026-09-06 (PDT), using
  wrangler 4.129.0:
  - `c4d4dcf6-3651-444f-a740-0ca55393defb` (21:50)
  - `2ca51f07-de52-4c87-9a6a-ff05099770c9` (22:04)
  - `1e582742-5c8a-4f4e-ac0c-1027c421051f`: the last observed deploy, at 22:12:08. It
    reports `Total Upload: 7.16 KiB / gzip: 2.38 KiB`.
- **Timing.** `src/index.js` was last modified at 22:11:38, about 30 s before the
  `1e582742` deploy began. No later edit exists. The operator session log for that
  deploy describes the change it shipped: stripping `Set-Cookie` / `cf-access-*`. That
  stripping is present in this `src/index.js`.
- **Live behaviour (observed 2026-10-06 from the Pi with `curl`).** It matches this source:
  - `OPTIONS /v1/daos` → `404 {"error":"not_found"}`. The route allowlist is GET/HEAD only.
  - `GET /v1/daos` with `Origin: https://gavel.0773h.com` → `200` with **no**
    `Access-Control-Allow-Origin`. The Worker does not forward `Origin`.
  - That GET carries `cache-control: public, max-age=45, s-maxage=45`, the Worker's
    rewritten cache policy.
  - `GET /health` → `404 {"error":"not_found"}`.

## What this does not prove

This is strong **circumstantial** evidence, not cryptographic proof. Specifically:

- Nobody has checked the deployed bundle hash against Cloudflare's version metadata.
  No Cloudflare API or dashboard was used to produce this record.
- Another deploy from a different machine or the dashboard after 2026-09-06 is not ruled out.
  The live behaviour only shows that whatever is deployed behaves like this source on the
  probes listed above.

Before any deployment of a change built on this import, Sysadmin should independently
confirm the currently active Worker version (for example `wrangler deployments list` /
`wrangler versions view` under an authorised account) and compare it with `1e582742-…`.
