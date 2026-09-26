-- Canonical governance lifecycle columns.
--
-- `proposal_status` keeps its existing meaning: the raw upstream value. What is
-- new is that Gavel's own derived verdict, and how closely a proposal still
-- needs observing, are first-class columns instead of being buried in the
-- normalized blob. The refresh set is planned from `tracking_state`, so a source
-- that reports a stale ACTIVE for a proposal that lost months ago can no longer
-- hold it in the hot set forever.
BEGIN;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS effective_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS tracking_state text NOT NULL DEFAULT 'HOT';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS lifecycle_reason text;
-- The finalized height the stored tallies were observed at. Terminalizing from
-- stored tallies is only sound once this is past `end_block`; NULL means "not
-- known", which costs one upstream refresh rather than a wrong verdict.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS last_observed_block bigint;

DO $$
BEGIN
  ALTER TABLE proposals ADD CONSTRAINT proposals_tracking_state_check
    CHECK (tracking_state IN ('HOT','WARM','FINAL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill from `outcome`, which is already Gavel's derived verdict at the
-- snapshot each row was written against — the value nothing consumed. Any row
-- this gets wrong is left non-FINAL, so the next incremental cycle re-derives it
-- rather than freezing a mistake.
UPDATE proposals SET
  effective_status = upper(outcome),
  tracking_state = CASE
    WHEN upper(outcome) IN ('DEFEATED','EXECUTED','CANCELLED','CANCELED','VETOED','EXPIRED','SPONSORSHIP_EXPIRED') THEN 'FINAL'
    WHEN upper(outcome) IN ('SUCCEEDED','QUEUED') THEN 'WARM'
    ELSE 'HOT'
  END,
  lifecycle_reason = 'migrated_from_outcome'
WHERE lifecycle_reason IS NULL;

-- The refresh planner's only query: everything still worth observing, cheapest
-- first. FINAL rows never appear in it, so the index stays small as history grows.
CREATE INDEX IF NOT EXISTS proposals_tracking_state_idx
  ON proposals (dao_id, tracking_state, updated_at)
  WHERE tracking_state <> 'FINAL';

INSERT INTO schema_migrations(version) VALUES ('003_proposal_lifecycle') ON CONFLICT DO NOTHING;
COMMIT;
