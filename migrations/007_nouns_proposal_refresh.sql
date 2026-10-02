BEGIN;
CREATE TABLE IF NOT EXISTS nouns_proposal_refreshes (
  dao_id text NOT NULL,
  source_id text NOT NULL,
  proposal_id numeric(78,0) NOT NULL,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9A-Fa-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dao_id, source_id, proposal_id),
  FOREIGN KEY (dao_id, source_id) REFERENCES governance_sources(dao_id, id)
);
INSERT INTO schema_migrations(version) VALUES ('007_nouns_proposal_refresh') ON CONFLICT DO NOTHING;
COMMIT;
