-- TRV-029: a capture source or a lead list enrols new leads into a chosen
-- managed campaign automatically.
--
-- One row is one rule: "new leads from THIS source go into THAT campaign".
-- Exactly one source column is set. Enrolment itself is not stored here; it is
-- the ordinary campaign-member row, written through the same admission path a
-- manual import uses, keyed by the derived member id, plus one append-only
-- `linkedin_campaign.member_auto_enrolled` domain event per new member.
--
-- Writer: createAutoEnrolRule. Closer: disableAutoEnrolRule (status
-- 'disabled', kept for the audit trail), and ON DELETE CASCADE from the
-- campaign, the capture source and the lead list, so a deleted campaign or
-- source leaves no rule behind. Workspace export and erasure find the table
-- through its workspace_id.

CREATE TABLE IF NOT EXISTS linkedin_campaign_auto_enrol_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  capture_source_id TEXT,
  lead_list_id TEXT REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by_user_id TEXT,
  disabled_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE,
  CHECK ((capture_source_id IS NULL) <> (lead_list_id IS NULL)),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

-- One active rule per (campaign, source); a disabled rule may be re-created.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_auto_enrol_rules_active
  ON linkedin_campaign_auto_enrol_rules(
    workspace_id, campaign_id, COALESCE(capture_source_id, ''), COALESCE(lead_list_id, '')
  )
  WHERE status = 'active';

-- The two arrival paths look rules up by source.
CREATE INDEX IF NOT EXISTS idx_linkedin_auto_enrol_rules_capture
  ON linkedin_campaign_auto_enrol_rules(workspace_id, capture_source_id)
  WHERE status = 'active' AND capture_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_linkedin_auto_enrol_rules_list
  ON linkedin_campaign_auto_enrol_rules(workspace_id, lead_list_id)
  WHERE status = 'active' AND lead_list_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_linkedin_auto_enrol_rules_campaign
  ON linkedin_campaign_auto_enrol_rules(workspace_id, campaign_id, created_at DESC);

COMMENT ON TABLE linkedin_campaign_auto_enrol_rules IS
  'TRV-029: new leads from one capture source or lead list enrol into one managed campaign through the manual admission path. Disabled rows are kept as history.';
