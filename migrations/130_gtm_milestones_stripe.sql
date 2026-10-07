-- GTM Phase A: product milestones, observe-only provider webhooks, and the
-- forward-only Opportunity stage ledger.
-- Plan: docs/superpowers/plans/2026-10-06-gtm-a-milestones-stripe-attribution.md
--
-- None of these tables stores provider content. A Stripe event is reduced to
-- its event id and object id before it reaches a row, and the signing secret is
-- sealed by Trevra secret custody (src/server/secrets/crypto.ts).

CREATE TABLE IF NOT EXISTS provider_webhook_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe','calcom')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_auth_tag BYTEA NOT NULL,
  secret_key_version INTEGER NOT NULL,
  secret_key_id TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,
  accepted_count BIGINT NOT NULL DEFAULT 0,
  rejected_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_endpoints_workspace
  ON provider_webhook_endpoints(workspace_id, provider, status);

COMMENT ON TABLE provider_webhook_endpoints IS
'One observe-only inbound webhook per row. The URL id decides the workspace; the sealed signing secret verifies the exact raw bytes. Closed by owner removal or workspace cascade.';

CREATE TABLE IF NOT EXISTS product_milestones (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'signed_up','activated','integration_connected','usage_threshold_crossed',
    'paid','upgraded','cancelled'
  )),
  contact_id TEXT NOT NULL,
  account_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('inbound_submission','stripe_event')),
  source_id TEXT NOT NULL,
  provider_endpoint_id TEXT REFERENCES provider_webhook_endpoints(id) ON DELETE SET NULL,
  external_object_id TEXT,
  milestone_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, milestone_key),
  UNIQUE (workspace_id, source_type, source_id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES accounts(workspace_id, id) ON DELETE SET NULL (account_id)
);

CREATE INDEX IF NOT EXISTS idx_product_milestones_recent
  ON product_milestones(workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_milestones_contact
  ON product_milestones(workspace_id, contact_id);

COMMENT ON TABLE product_milestones IS
'First-party product/billing outcomes. Provenance is ids only (submission id or Stripe event/object id); never amounts, line items or invoice details.';

CREATE TABLE IF NOT EXISTS opportunity_stage_observations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  previous_stage TEXT,
  stage TEXT NOT NULL,
  created BOOLEAN NOT NULL,
  changed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_stage_observations_opportunity
  ON opportunity_stage_observations(opportunity_id);

COMMENT ON TABLE opportunity_stage_observations IS
'Idempotency ledger for advanceOpportunityStage: one row per observed source. Closed with its Opportunity or workspace.';
