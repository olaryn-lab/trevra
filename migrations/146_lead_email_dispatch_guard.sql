-- Speed the final shared email provider-boundary opt-out guard for imported
-- LinkedIn leads. The exact normalized expression matches the dispatch read.
-- This is additive only; no production data is rewritten or erased.
-- trevra:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_lead_email_dispatch_guard
  ON linkedin_lead_contacts (workspace_id, LOWER(BTRIM(email)))
  WHERE email IS NOT NULL;
