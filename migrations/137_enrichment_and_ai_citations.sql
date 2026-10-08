-- Phase F: bring-your-own-key contact enrichment and AI-answer citation samples.
--
-- The Hunter API key is NOT stored here. It is sealed in workspace_secrets
-- (kind 'hunter_api_key') like every other workspace credential.

-- One row per workspace. A missing row means "cap 0, key unchecked": enrichment
-- is off until an owner sets a cap, and every plan is blocked until then.
CREATE TABLE IF NOT EXISTS enrichment_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'hunter' CHECK (provider IN ('hunter')),
  monthly_credit_cap NUMERIC(10,1) NOT NULL DEFAULT 0
    CHECK (monthly_credit_cap >= 0 AND monthly_credit_cap <= 100000),
  key_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (key_status IN ('unchecked', 'valid', 'invalid')),
  key_checked_at TIMESTAMPTZ,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per approved enrich_contacts plan. Queued and running rows reserve
-- their unspent estimate against the monthly cap.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('hunter')),
  idempotency_key TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  domains TEXT[] NOT NULL CHECK (cardinality(domains) BETWEEN 1 AND 100),
  emails_per_domain INTEGER NOT NULL CHECK (emails_per_domain BETWEEN 1 AND 10),
  include_unverified BOOLEAN NOT NULL DEFAULT FALSE,
  estimated_credits NUMERIC(10,1) NOT NULL CHECK (estimated_credits > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS enrichment_runs_open_idx
  ON enrichment_runs(created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS enrichment_runs_finished_idx
  ON enrichment_runs(finished_at) WHERE finished_at IS NOT NULL;

-- Append-only: one row per paid provider call, written before the result is
-- used. run_id has no FK so the ledger outlives a pruned run row until its own
-- 13-month retention.
CREATE TABLE IF NOT EXISTS enrichment_usage_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('hunter')),
  operation TEXT NOT NULL CHECK (operation IN ('domain_search', 'email_verifier')),
  credits NUMERIC(10,1) NOT NULL CHECK (credits >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS enrichment_usage_ledger_month_idx
  ON enrichment_usage_ledger(workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS enrichment_usage_ledger_run_idx
  ON enrichment_usage_ledger(workspace_id, run_id);
-- The worker prunes across workspaces on every enrichment tick.
CREATE INDEX IF NOT EXISTS enrichment_usage_ledger_occurred_idx
  ON enrichment_usage_ledger(occurred_at);

-- One signed AI-answer citation source per brand watch. The capture source is
-- an ordinary capture_sources row of kind 'ai_citations', so it reuses the
-- sealed secret, rotation and disable machinery unchanged.
CREATE TABLE IF NOT EXISTS brand_watch_citation_sources (
  watch_id TEXT PRIMARY KEY REFERENCES brand_watches(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capture_source_id TEXT NOT NULL UNIQUE,
  owned_domains TEXT[] NOT NULL CHECK (cardinality(owned_domains) BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE
);

-- Content-free sample state. No answer text, no prompt text: prompt_ref is a
-- stable id or a sha256 of the prompt. change records what this sample did
-- relative to the latest earlier sample for the same engine and prompt.
CREATE TABLE IF NOT EXISTS ai_citation_samples (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  watch_id TEXT NOT NULL REFERENCES brand_watches(id) ON DELETE CASCADE,
  capture_source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  prompt_ref TEXT NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL,
  brand_cited BOOLEAN NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('gained', 'lost', 'kept', 'absent', 'stale')),
  mention_id TEXT REFERENCES brand_watch_mentions(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (capture_source_id, idempotency_key),
  UNIQUE (watch_id, sample_id),
  FOREIGN KEY (workspace_id, capture_source_id)
    REFERENCES capture_sources(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_citation_samples_latest_idx
  ON ai_citation_samples(watch_id, engine, prompt_ref, answered_at DESC);
CREATE INDEX IF NOT EXISTS ai_citation_samples_received_idx
  ON ai_citation_samples(received_at);
