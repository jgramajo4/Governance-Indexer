-- Least-privilege grants. Applied separately from the schema so a missing role
-- is reported instead of being silently skipped: gavel_api must never hold a
-- write privilege on governance data.
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO gavel_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gavel_indexer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gavel_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gavel_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gavel_indexer;

-- The API role is read-only. Revoke first so re-running this file cannot leave
-- a stale write grant behind, then grant SELECT and nothing else.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gavel_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gavel_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM gavel_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM gavel_api;
GRANT USAGE ON SCHEMA public TO gavel_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO gavel_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gavel_api;

INSERT INTO schema_migrations(version) VALUES ('002_roles') ON CONFLICT DO NOTHING;
COMMIT;
