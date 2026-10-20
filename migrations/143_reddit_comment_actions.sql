-- Reddit browser comments are prepared and claimed before any external write.
-- Unknown outcomes remain held permanently until reconciled by a human.
CREATE TABLE IF NOT EXISTS reddit_comment_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_url TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared','executing','posted','failed','unknown')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  external_ref TEXT,
  failure_kind TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,content_hash)
);
CREATE INDEX IF NOT EXISTS idx_reddit_comments_pending
  ON reddit_comment_actions(workspace_id,created_at DESC)
  WHERE status IN ('prepared','executing','unknown','failed');
CREATE TABLE IF NOT EXISTS reddit_comment_policy_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES reddit_comment_actions(id) ON DELETE CASCADE,
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved','allowed','denied','held')),
  policy_name TEXT NOT NULL,
  policy_effect TEXT NOT NULL,
  actor_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reddit_comments_policy_dedup
  ON reddit_comment_policy_events(workspace_id,comment_id,decision,policy_effect)
  WHERE decision <> 'approved';
