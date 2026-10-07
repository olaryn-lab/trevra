-- GitHub repository traction (Phase C).
--
-- Both tables carry workspace_id with ON DELETE CASCADE, so the workspace
-- export and erasure catalogue in app.ts finds them without being told.
--
-- watched_repositories: the founder's own public repositories Trevra polls,
-- plus the bookkeeping that keeps the poll cheap (per-kind cursors, ETags) and
-- honest (a status the Setup card shows). Never credentials: the GitHub token
-- lives in Nango.
CREATE TABLE IF NOT EXISTS watched_repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ok','not_found','rate_limited','needs_reauth','not_connected','error')),
  last_error TEXT,
  stars_cursor TIMESTAMPTZ,
  forks_cursor TIMESTAMPTZ,
  issues_cursor TIMESTAMPTZ,
  repo_etag TEXT,
  issues_etag TEXT,
  rate_limited_until TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_until TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  -- Counts only (PollSummary in src/server/github/repos.ts). No names, no content.
  last_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- People whose public profile ties them to no company. Counted, never stored.
  unresolved_total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_repositories_name
  ON watched_repositories (workspace_id, LOWER(owner), LOWER(name));
CREATE INDEX IF NOT EXISTS idx_watched_repositories_due
  ON watched_repositories (workspace_id, next_poll_at);

-- github_repo_actors: only GitHub people Trevra RESOLVED to an account, so the
-- next star from the same login skips the profile lookup. Minimal personal
-- data: the public login and profile URL. No email column, on purpose. Closed
-- by the account (cascade) and by the workspace (cascade).
CREATE TABLE IF NOT EXISTS github_repo_actors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  resolved_domain TEXT NOT NULL,
  resolved_via TEXT NOT NULL CHECK (resolved_via IN ('org_website','email_domain','blog')),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_repo_actors_login
  ON github_repo_actors (workspace_id, LOWER(login));
CREATE INDEX IF NOT EXISTS idx_github_repo_actors_account
  ON github_repo_actors (workspace_id, account_id);

COMMENT ON TABLE watched_repositories IS
'Public GitHub repositories a workspace watches for stars, forks and outside issues; polling state only.';
COMMENT ON TABLE github_repo_actors IS
'GitHub logins resolved to an account from public profile data; login and profile URL only.';
