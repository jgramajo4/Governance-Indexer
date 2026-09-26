#!/bin/sh
set -eu

: "${GAVEL_INDEXER_DB_PASSWORD:?GAVEL_INDEXER_DB_PASSWORD is required}"
: "${GAVEL_API_DB_PASSWORD:?GAVEL_API_DB_PASSWORD is required}"

# Read secrets inside psql so they never appear in process argv. format(%L)
# quotes password literals server-side; these are fresh-volume roles and the
# migrate path performs the authoritative reused-volume reconciliation.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\set QUIET on
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
\getenv indexer_password GAVEL_INDEXER_DB_PASSWORD
\getenv api_password GAVEL_API_DB_PASSWORD
SELECT format('CREATE ROLE gavel_indexer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L', :'indexer_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gavel_indexer') \gexec
SELECT format('CREATE ROLE gavel_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L', :'api_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gavel_api') \gexec
GRANT CONNECT ON DATABASE gavel TO gavel_indexer, gavel_api;
SQL
