BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS daos (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name text NOT NULL DEFAULT '',
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  governance_type text NOT NULL DEFAULT 'onchain',
  current_governor text CHECK (current_governor IS NULL OR current_governor ~ '^0x[0-9A-Fa-f]{40}$'),
  contract_address text CHECK (contract_address IS NULL OR contract_address ~ '^0x[0-9A-Fa-f]{40}$'),
  from_block bigint NOT NULL CHECK (from_block > 0),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governance_sources (
  dao_id text NOT NULL REFERENCES daos(id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL,
  endpoint text NOT NULL,
  from_block bigint NOT NULL CHECK (from_block > 0),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (dao_id, id)
);
CREATE TABLE IF NOT EXISTS raw_governance_records (
  id bigserial PRIMARY KEY,
  dao_id text NOT NULL REFERENCES daos(id),
  source_id text NOT NULL,
  source_record_key text,
  external_id text,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9A-Fa-f]{40}$'),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  log_index integer CHECK (log_index IS NULL OR log_index >= 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  record_type text NOT NULL,
  proposal_id numeric(78,0),
  content_hash char(64) CHECK (content_hash IS NULL OR content_hash ~ '^[0-9A-Fa-f]{64}$'),
  payload jsonb NOT NULL,
  source_kind text NOT NULL,
  source_endpoint text NOT NULL,
  observed_head bigint NOT NULL CHECK (observed_head >= 0),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address, transaction_hash, log_index),
  UNIQUE (dao_id, source_id, source_record_key),
  CHECK (source_record_key IS NOT NULL OR (transaction_hash IS NOT NULL AND log_index IS NOT NULL)),
  FOREIGN KEY (dao_id, source_id) REFERENCES governance_sources(dao_id, id)
);
CREATE TABLE IF NOT EXISTS proposals (
  dao_id text NOT NULL REFERENCES daos(id),
  proposal_id numeric(78,0) NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9A-Fa-f]{64}$'),
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  proposer text,
  proposal_status text NOT NULL DEFAULT 'UNKNOWN',
  outcome text NOT NULL DEFAULT 'UNKNOWN',
  created_block bigint,
  start_block bigint,
  end_block bigint,
  quorum_votes numeric(78,0),
  for_votes numeric(78,0),
  against_votes numeric(78,0),
  abstain_votes numeric(78,0),
  normalized jsonb NOT NULL,
  first_seen_block bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dao_id, proposal_id)
);
CREATE TABLE IF NOT EXISTS proposal_actions (
  dao_id text NOT NULL,
  proposal_id numeric(78,0) NOT NULL,
  action_index integer NOT NULL CHECK (action_index >= 0),
  target text NOT NULL,
  value_wei numeric(78,0) NOT NULL,
  signature text NOT NULL DEFAULT '',
  calldata text NOT NULL,
  PRIMARY KEY (dao_id, proposal_id, action_index),
  FOREIGN KEY (dao_id, proposal_id) REFERENCES proposals(dao_id, proposal_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS vote_events (
  id bigserial PRIMARY KEY,
  dao_id text NOT NULL REFERENCES daos(id),
  source_id text,
  source_record_key text,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9A-Fa-f]{40}$'),
  proposal_id numeric(78,0) NOT NULL,
  voter text NOT NULL CHECK (voter ~ '^0x[0-9A-Fa-f]{40}$'),
  support text NOT NULL CHECK (support IN ('AGAINST','FOR','ABSTAIN')),
  reason text,
  vote_weight numeric(78,0) NOT NULL CHECK (vote_weight >= 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_time timestamptz NOT NULL,
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  source_kind text NOT NULL,
  source_endpoint text NOT NULL,
  source_public_endpoint text NOT NULL,
  observed_head bigint NOT NULL CHECK (observed_head >= 0),
  normalized jsonb,
  UNIQUE (chain_id, contract_address, transaction_hash, log_index),
  UNIQUE (dao_id, source_id, source_record_key)
);
CREATE INDEX IF NOT EXISTS vote_events_voter_history ON vote_events (dao_id, lower(voter), block_number, lower(transaction_hash), log_index);
CREATE INDEX IF NOT EXISTS vote_events_proposal_idx ON vote_events (dao_id, proposal_id, block_number);
CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals (dao_id, proposal_status, proposal_id DESC);
CREATE INDEX IF NOT EXISTS raw_governance_external_id_idx ON raw_governance_records (dao_id, source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_governance_block_idx ON raw_governance_records (dao_id, block_number, log_index);
CREATE INDEX IF NOT EXISTS raw_governance_proposal_idx ON raw_governance_records (dao_id, proposal_id) WHERE record_type = 'proposal';
CREATE TABLE IF NOT EXISTS delegation_events (
  id bigserial PRIMARY KEY,
  dao_id text NOT NULL REFERENCES daos(id),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9A-Fa-f]{40}$'),
  delegator text NOT NULL CHECK (delegator ~ '^0x[0-9A-Fa-f]{40}$'),
  delegatee text NOT NULL CHECK (delegatee ~ '^0x[0-9A-Fa-f]{40}$'),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_time timestamptz NOT NULL,
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  source_kind text NOT NULL,
  source_endpoint text NOT NULL,
  normalized jsonb,
  UNIQUE (chain_id, contract_address, transaction_hash, log_index)
);
CREATE TABLE IF NOT EXISTS sync_checkpoints (
  dao_id text NOT NULL,
  source_id text NOT NULL,
  next_block bigint NOT NULL CHECK (next_block > 0),
  finalized_head bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_full_scan_at timestamptz,
  last_error text,
  PRIMARY KEY (dao_id, source_id),
  FOREIGN KEY (dao_id, source_id) REFERENCES governance_sources(dao_id, id)
);
INSERT INTO schema_migrations(version) VALUES ('001_initial') ON CONFLICT DO NOTHING;
COMMIT;
