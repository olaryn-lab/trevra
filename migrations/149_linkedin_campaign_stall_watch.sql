-- Detect an actionable LinkedIn campaign that has stopped advancing, without
-- mailing the workspace owner on every worker tick or across worker replicas.
-- A candidate must remain eligible across several scan intervals. Pauses,
-- offline Companions, account cooldowns and scheduled waits are excluded in
-- application logic by the same safety gate used for sends.
CREATE TABLE IF NOT EXISTS linkedin_campaign_stall_alerts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  seat_key TEXT NOT NULL,
  first_detected_at TIMESTAMPTZ NOT NULL,
  last_detected_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, campaign_id, seat_key)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_stall_alerts_notification
  ON linkedin_campaign_stall_alerts(last_detected_at, last_notified_at);
