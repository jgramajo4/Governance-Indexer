BEGIN;
CREATE TABLE IF NOT EXISTS candidate_snapshots (
  dao_id text NOT NULL,
  source_id text NOT NULL,
  checkpoint_block bigint NOT NULL CHECK (checkpoint_block >= 0),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^0x[0-9a-fA-F]{64}$'),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dao_id, source_id),
  FOREIGN KEY (dao_id, source_id) REFERENCES governance_sources(dao_id, id) ON DELETE CASCADE
);
INSERT INTO schema_migrations(version) VALUES ('006_nouns_candidate_cache') ON CONFLICT DO NOTHING;
COMMIT;
