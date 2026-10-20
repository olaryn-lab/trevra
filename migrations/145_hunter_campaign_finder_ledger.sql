-- A campaign's found-only Hunter email lookup consumes the same workspace
-- monthly cap as ordinary contact enrichment. Reserve before the provider
-- call so uncertain outcomes cannot escape metering.
ALTER TABLE enrichment_usage_ledger
  DROP CONSTRAINT IF EXISTS enrichment_usage_ledger_operation_check;
ALTER TABLE enrichment_usage_ledger
  ADD CONSTRAINT enrichment_usage_ledger_operation_check
  CHECK (operation IN ('domain_search','email_verifier','email_finder'));
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_usage_campaign_finder_unique
  ON enrichment_usage_ledger(workspace_id,run_id,operation)
  WHERE operation='email_finder';
