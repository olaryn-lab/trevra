-- Per-post exact human grants. Separate from individual LinkedIn action grants:
-- posts are editable and carry binary media that must be hashed at review.
CREATE TABLE IF NOT EXISTS linkedin_post_approvals (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES linkedin_posts(id) ON DELETE CASCADE,
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id,post_id)
);
CREATE TABLE IF NOT EXISTS linkedin_post_policy_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES linkedin_posts(id) ON DELETE CASCADE,
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved','allowed','denied','held','changed')),
  policy_name TEXT NOT NULL,
  policy_effect TEXT NOT NULL,
  actor_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_post_policy_decision_dedup
  ON linkedin_post_policy_events(workspace_id,post_id,content_hash,decision,policy_effect)
  WHERE decision<>'approved';
