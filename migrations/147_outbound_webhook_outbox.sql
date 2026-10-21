-- Tenant-scoped, replay-safe outbound webhooks. Only explicit lifecycle events
-- (not arbitrary sensitive domain payloads) are eligible for publication.
-- Additive. No live endpoint is contacted during migration.
CREATE TABLE outbound_webhook_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  event_types TEXT[] NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version INTEGER NOT NULL,
  key_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT outbound_webhook_subscription_events_nonempty CHECK (array_length(event_types,1)>0)
);
CREATE INDEX idx_outbound_webhook_subscriptions_active
  ON outbound_webhook_subscriptions(workspace_id) WHERE active;

CREATE TABLE outbound_webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES outbound_webhook_subscriptions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id,event_id)
);
CREATE INDEX idx_outbound_webhook_deliveries_claim
  ON outbound_webhook_deliveries(next_attempt_at,id)
  WHERE status IN ('pending','leased');
CREATE INDEX idx_outbound_webhook_deliveries_tenant
  ON outbound_webhook_deliveries(workspace_id,created_at DESC);
