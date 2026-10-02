BEGIN;
-- Freeze the existing subgraph checkpoint exactly once, before the RPC worker can
-- advance it. A fresh index has no checkpoint and needs no legacy boundary.
UPDATE governance_sources AS s
SET config = jsonb_set(s.config, '{rpcCutoverBlock}', to_jsonb(c.next_block), true)
FROM sync_checkpoints AS c
WHERE s.dao_id='nouns' AND s.id='nouns-subgraph'
  AND c.dao_id=s.dao_id AND c.source_id=s.id
  AND NOT (s.config ? 'rpcCutoverBlock')
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='005_nouns_rpc_cutover');
INSERT INTO schema_migrations(version) VALUES ('005_nouns_rpc_cutover') ON CONFLICT DO NOTHING;
COMMIT;
