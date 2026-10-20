-- Human review of the *individual* rendered email and its sender, not a
-- campaign-wide blank cheque. The send boundary re-hashes the current content.
CREATE TABLE IF NOT EXISTS linkedin_campaign_email_approvals (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL REFERENCES linkedin_campaign_channel_actions(id) ON DELETE CASCADE,
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, action_id)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_email_approvals_action
  ON linkedin_campaign_email_approvals(action_id);
