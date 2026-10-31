-- TRV-057: last-known Billing snapshot per workspace, and the annual renewal
-- notice dedupe. Additive. No Billing call is made during migration.
--
-- billing_workspace_state is a cache, never the commercial source of truth:
-- Olaryn Billing (Stripe + OpenMeter) owns plans, credits and entitlements.
-- Trevra keeps the last snapshot it read so the entitlement gate can keep
-- answering for a bounded grace window while Billing is unreachable. One row
-- per workspace, overwritten in place on every refresh, removed with its
-- workspace (ON DELETE CASCADE) -- it cannot grow, so it needs no retention job.
-- The snapshot never carries credentials, billing e-mail or invoice ids;
-- the writer strips them before the row is stored.
CREATE TABLE IF NOT EXISTS billing_workspace_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_json JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  -- Metered usage is reported only for work that happened after this point,
  -- so turning Billing on never back-bills history.
  metering_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- The worker refreshes the stalest snapshots first.
CREATE INDEX IF NOT EXISTS idx_billing_workspace_state_fetched
  ON billing_workspace_state(fetched_at);

-- One owner notice per workspace per annual renewal date. The claim columns
-- follow linkedin_campaign_stall_notifications: a worker claims the row,
-- sends, then stamps notified_at; a failed send releases the claim. Rows are
-- pruned by the billing worker cycle once the renewal date is 400 days past.
CREATE TABLE IF NOT EXISTS billing_renewal_notices (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  renewal_on DATE NOT NULL,
  plan_code TEXT NOT NULL,
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, renewal_on)
);
CREATE INDEX IF NOT EXISTS idx_billing_renewal_notices_renewal
  ON billing_renewal_notices(renewal_on);
