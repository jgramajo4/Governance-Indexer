BEGIN;
CREATE TABLE IF NOT EXISTS governance_targets (
  dao_id text NOT NULL REFERENCES daos(id),
  target_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('candidate')),
  proposer text NOT NULL CHECK (proposer ~ '^0x[0-9a-f]{40}$'),
  slug text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  native_state text NOT NULL CHECK (native_state IN ('ACTIVE','CANCELED')),
  eligibility text NOT NULL CHECK (eligibility IN ('PRE_VOTE','CLOSED')),
  mapping_version text NOT NULL CHECK (mapping_version = 'nouns-candidate-lifecycle/1'),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array'),
  latest_version jsonb NOT NULL CHECK (jsonb_typeof(latest_version) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dao_id, target_id),
  UNIQUE (dao_id, proposer, slug),
  CHECK (target_id ~ ('^candidate:' || proposer || ':0x[0-9a-f]{64}$')),
  CHECK ((native_state = 'ACTIVE' AND eligibility IN ('PRE_VOTE','CLOSED'))
    OR (native_state = 'CANCELED' AND eligibility = 'CLOSED'))
);
CREATE INDEX IF NOT EXISTS governance_targets_eligibility_idx ON governance_targets(dao_id, eligibility, updated_at DESC);
INSERT INTO schema_migrations(version) VALUES ('004_nouns_candidates') ON CONFLICT DO NOTHING;
COMMIT;
