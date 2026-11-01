-- TRV-057: durable, replay-safe outbox for metered usage reported to Olaryn
-- Billing. Additive. No Billing call is made during migration.
--
-- The primary key is the deterministic usage event id
-- sha256(workspace_id|meter|source_type|source_id), so enqueueing the same
-- source action twice is a no-op, and the Billing reservation idempotency key
-- is derived from it, so a retried report cannot be counted twice either.
-- Only `credits` is metered: it is the one meter Billing consumes.
--
-- Closer: the billing worker cycle deletes finished rows (reported, rejected,
-- dead) 90 days after they finish. The enqueue lookback is far shorter than
-- that, so a pruned row can never be re-enqueued.
CREATE TABLE IF NOT EXISTS billing_usage_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meter TEXT NOT NULL CHECK (meter IN ('credits')),
  operation TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reported','rejected','dead')),
  reservation_id TEXT,
  reservation_generation INTEGER NOT NULL DEFAULT 0 CHECK (reservation_generation>=0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  last_error TEXT,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, meter, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_usage_outbox_claim
  ON billing_usage_outbox(next_attempt_at, id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_billing_usage_outbox_tenant
  ON billing_usage_outbox(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_usage_outbox_finished
  ON billing_usage_outbox(finished_at) WHERE status<>'pending';
