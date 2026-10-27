-- A durable dedupe and crash-recovery lease for actionable campaign stalls.
-- SMTP cannot provide exactly-once delivery; a crash after sending but before
-- recording completion may produce a retry, bounded by the claim timeout.
CREATE TABLE IF NOT EXISTS linkedin_campaign_stall_notifications (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  claimed_at timestamptz,
  claim_token text,
  last_notified_at timestamptz,
  PRIMARY KEY (workspace_id,campaign_id)
);
