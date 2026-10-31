-- TRV-052 outbound webhook hardening. Additive only: signing-secret rotation
-- with a bounded overlap, failure streaks and auto-disable state on the
-- subscription, replay series on the delivery, and one row per delivery
-- attempt (status, HTTP code, latency, reason code -- never a response body).
-- No live endpoint is contacted during migration.
ALTER TABLE outbound_webhook_subscriptions
  ADD COLUMN previous_ciphertext BYTEA,
  ADD COLUMN previous_iv BYTEA,
  ADD COLUMN previous_auth_tag BYTEA,
  ADD COLUMN previous_key_version INTEGER,
  ADD COLUMN previous_key_id TEXT,
  ADD COLUMN previous_secret_expires_at TIMESTAMPTZ,
  ADD COLUMN secret_rotated_at TIMESTAMPTZ,
  ADD COLUMN disabled_reason TEXT,
  ADD COLUMN disabled_at TIMESTAMPTZ,
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN failing_since TIMESTAMPTZ,
  ADD COLUMN last_failure_code TEXT,
  ADD COLUMN last_failure_at TIMESTAMPTZ,
  ADD COLUMN last_success_at TIMESTAMPTZ,
  ADD CONSTRAINT outbound_webhook_subscription_failures_nonnegative
    CHECK (consecutive_failures >= 0),
  ADD CONSTRAINT outbound_webhook_subscription_disabled_reason
    CHECK (disabled_reason IS NULL OR disabled_reason IN ('owner','consecutive_failures')),
  -- The overlap secret is all-or-nothing and always carries its own expiry.
  ADD CONSTRAINT outbound_webhook_subscription_previous_secret_complete CHECK (
    (previous_ciphertext IS NULL AND previous_iv IS NULL AND previous_auth_tag IS NULL
      AND previous_key_version IS NULL AND previous_secret_expires_at IS NULL)
    OR (previous_ciphertext IS NOT NULL AND previous_iv IS NOT NULL AND previous_auth_tag IS NOT NULL
      AND previous_key_version IS NOT NULL AND previous_secret_expires_at IS NOT NULL)
  );

-- Existing deactivations predate disabled_reason; they were all owner actions.
UPDATE outbound_webhook_subscriptions
  SET disabled_reason='owner',disabled_at=updated_at
  WHERE active=FALSE AND disabled_reason IS NULL;

ALTER TABLE outbound_webhook_deliveries
  ADD COLUMN attempt_series INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_reason_code TEXT,
  ADD COLUMN dead_at TIMESTAMPTZ,
  ADD COLUMN replayed_at TIMESTAMPTZ,
  ADD CONSTRAINT outbound_webhook_delivery_series_nonnegative CHECK (attempt_series >= 0);

CREATE TABLE outbound_webhook_delivery_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES outbound_webhook_subscriptions(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES outbound_webhook_deliveries(id) ON DELETE CASCADE,
  attempt_series INTEGER NOT NULL CHECK (attempt_series >= 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','failed','blocked')),
  http_status INTEGER,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  reason_code TEXT,
  attempted_at TIMESTAMPTZ NOT NULL,
  UNIQUE (delivery_id,attempt_series,attempt_number)
);
CREATE INDEX idx_outbound_webhook_attempts_subscription
  ON outbound_webhook_delivery_attempts(workspace_id,subscription_id,attempted_at DESC);
-- Retention sweep (worker) deletes by age.
CREATE INDEX idx_outbound_webhook_attempts_age
  ON outbound_webhook_delivery_attempts(attempted_at);
