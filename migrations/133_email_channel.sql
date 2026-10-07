-- Phase D: email as a governed peer channel.
--
-- connections.mailbox_address caches the provider-verified address of a
-- Gmail/Microsoft 365 connection (Gmail users/me/profile, Graph /me). It is
-- identity, not a credential, and is cleared whenever Nango re-authorizes the
-- connection so a different account can never inherit the old address.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS mailbox_address TEXT;

-- Cached SPF/DKIM/DMARC evaluation for one sending domain and mail provider.
-- status is pass, fail or unknown: a DNS timeout is unknown and never pass.
-- outreach_requested_at is set only when someone plans email outreach from
-- this domain; Today shows deliverability_blocked only for those rows.
CREATE TABLE IF NOT EXISTS email_deliverability_checks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain = LOWER(domain) AND domain <> ''),
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  status TEXT NOT NULL CHECK (status IN ('pass','fail','unknown')),
  spf_json JSONB NOT NULL,
  dkim_json JSONB NOT NULL,
  dmarc_json JSONB NOT NULL,
  blockers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  outreach_requested_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, domain, provider)
);
CREATE INDEX IF NOT EXISTS idx_email_deliverability_checks_due
  ON email_deliverability_checks(expires_at);

-- The one mailbox per workspace whose inbox the Nango inbound-messages sync
-- reads. Records from any other connection or address are ignored.
CREATE TABLE IF NOT EXISTS email_inbound_mailboxes (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address = LOWER(address) AND POSITION('@' IN address) > 1),
  sync_status TEXT NOT NULL CHECK (sync_status IN ('starting','syncing','unavailable')),
  sync_error TEXT,
  designated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  designated_at TIMESTAMPTZ NOT NULL,
  last_record_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_inbound_mailboxes_connection
  ON email_inbound_mailboxes(connection_id);

-- Narrow idempotency receipt for email-only prepare_outreach. Not a job table:
-- it binds one prepare key to one plan hash and the playbook runs it created.
CREATE TABLE IF NOT EXISTS email_outreach_preparations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  lead_list_id TEXT NOT NULL,
  connection_id TEXT,
  run_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, idempotency_key)
);

-- One run per per-person preparation key, and at most one open approval per
-- Person, so a double click or two racing prepares cannot queue two emails.
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_runs_email_outreach_idempotency
  ON playbook_runs(workspace_id,(input_json->>'idempotencyKey'))
  WHERE playbook_key='gtm.email-outreach' AND input_json ? 'idempotencyKey';
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_runs_email_outreach_open_person
  ON playbook_runs(workspace_id,(input_json->>'personId'))
  WHERE playbook_key='gtm.email-outreach'
    AND status IN ('queued','running','waiting_approval');

COMMENT ON COLUMN connections.mailbox_address IS
'Provider-verified mailbox address for Gmail/Microsoft 365 connections; cleared on re-authorization.';
COMMENT ON TABLE email_deliverability_checks IS
'Cached SPF/DKIM/DMARC evaluation per workspace sending domain; unknown never counts as pass. Pruned 30 days after the last check.';
COMMENT ON TABLE email_inbound_mailboxes IS
'The single designated inbound mailbox per workspace for the Nango inbound-messages sync.';
COMMENT ON TABLE email_outreach_preparations IS
'Idempotency receipt for email-only prepare_outreach; not a scheduler or universal GTM job.';
