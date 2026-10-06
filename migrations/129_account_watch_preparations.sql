-- Narrow idempotency ledger for GTM "watch accounts" preparation.
--
-- This is not a generic Job object. It only binds one prepare request to the
-- canonical Account ids/result it created or reused, so retries are exact and
-- the same key cannot later be reused for a materially different plan.
CREATE TABLE IF NOT EXISTS account_watch_preparations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  account_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, idempotency_key)
);

COMMENT ON TABLE account_watch_preparations IS
'Idempotency/correlation ledger for composed watch_accounts preparation; not a scheduler or universal GTM job.';
