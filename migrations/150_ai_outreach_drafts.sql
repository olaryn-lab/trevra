-- TRV-039: lead-specific AI drafts of campaign outreach copy.
--
-- A row is a PROPOSAL, never a send. The model drafts text from stored evidence;
-- a human approves the exact payload hash through the existing per-action
-- approvals (139 email, 140 LinkedIn). The send boundaries re-hash the queued
-- payload, so an edit after approval -- or any drift -- refuses to send.
--
-- Exactly one target action per draft: a queued LinkedIn browser action
-- (invite / dm / inmail) or a queued campaign email channel action.
--
-- RETENTION. Approved and sent drafts are provenance for the bytes that went
-- out and live as long as the action they describe (cascade with the action,
-- member, campaign or workspace). Terminal non-applied rows (rejected,
-- superseded, edited) are pruned after 90 days by `pruneAiDrafts`, which runs
-- on every draft request; idx_ai_outreach_drafts_retention serves that sweep.
-- No key, prompt or provider credential is ever stored here: `model_label` is
-- the configured model id only.
CREATE TABLE IF NOT EXISTS ai_outreach_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES linkedin_campaign_members(id) ON DELETE CASCADE,
  workflow_step_id TEXT NOT NULL,
  linkedin_action_id TEXT REFERENCES linkedin_actions(id) ON DELETE CASCADE,
  channel_action_id TEXT REFERENCES linkedin_campaign_channel_actions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL
    CHECK (channel IN ('linkedin_invite','linkedin_message','linkedin_inmail','email')),
  origin TEXT NOT NULL CHECK (origin IN ('model','template_fallback','human_edit')),
  model_label TEXT,
  evidence_hash CHAR(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_text TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  fallback_reason TEXT,
  parent_draft_id TEXT REFERENCES ai_outreach_drafts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','edited','rejected','superseded','sent')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  CHECK ((linkedin_action_id IS NULL) <> (channel_action_id IS NULL))
);

-- Review list per campaign, newest first.
CREATE INDEX IF NOT EXISTS idx_ai_outreach_drafts_campaign
  ON ai_outreach_drafts(workspace_id, campaign_id, created_at DESC);
-- One live proposal per queued action: a new request supersedes the old one
-- inside the same transaction, so two reviewers never approve different text.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_outreach_drafts_one_proposed_linkedin
  ON ai_outreach_drafts(linkedin_action_id)
  WHERE status='proposed' AND linkedin_action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_outreach_drafts_one_proposed_channel
  ON ai_outreach_drafts(channel_action_id)
  WHERE status='proposed' AND channel_action_id IS NOT NULL;
-- Send-boundary lookups ("was this action's body AI drafted?") and cascades.
CREATE INDEX IF NOT EXISTS idx_ai_outreach_drafts_linkedin_action
  ON ai_outreach_drafts(workspace_id, linkedin_action_id, status)
  WHERE linkedin_action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_outreach_drafts_channel_action
  ON ai_outreach_drafts(workspace_id, channel_action_id, status)
  WHERE channel_action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_outreach_drafts_member
  ON ai_outreach_drafts(member_id);
CREATE INDEX IF NOT EXISTS idx_ai_outreach_drafts_parent
  ON ai_outreach_drafts(parent_draft_id)
  WHERE parent_draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_outreach_drafts_retention
  ON ai_outreach_drafts(workspace_id, created_at)
  WHERE status IN ('rejected','superseded','edited');
