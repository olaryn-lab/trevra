-- TRV-051: prepared CRM contact upserts (`crm.upsert-contact`).
--
-- One row per distinct prepared payload. Prepare searches the connected CRM in a
-- fixed order (stored link, LinkedIn URL, email, name + company), and writes the
-- exact approved payload and its hash here. Execution claims the row under a row
-- lock, re-reads the CRM, and refuses with `stale_prepare` when the record moved.
--
-- Status:
--   prepared          -- payload persisted; waiting on approval or on a retry
--   blocked_ambiguous -- a tier matched more than one CRM record; nothing is
--                        written until a human resolves it (candidate_ids_json)
--   up_to_date        -- matched, and there was nothing empty to fill
--   executing         -- claimed; lease_expires_at bounds a crashed attempt
--   succeeded         -- the CRM confirmed; result_record_id is its id
--   stale_prepare     -- the CRM changed after prepare; prepare again
--   failed            -- terminal provider refusal (error_code records it)
--   superseded        -- a newer prepare for the same lead + connection exists
--
-- Retention: this is the audit ledger for an approved external write, like
-- crm_activities. Rows are closed by cascade with their lead, connection or
-- workspace, so erasing a lead erases its CRM sync history and payloads.

CREATE TABLE IF NOT EXISTS crm_contact_upserts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  person_id TEXT,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'prepared','blocked_ambiguous','up_to_date','executing','succeeded',
    'stale_prepare','failed','superseded'
  )),
  operation TEXT CHECK (operation IN ('create','update','none')),
  match_tier TEXT NOT NULL CHECK (match_tier IN (
    'crm_link','linkedin_url','email','name_company','none'
  )),
  crm_record_id TEXT,
  candidate_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Planned fields, conflicts and skipped fields, for review.
  plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json JSONB,
  payload_hash TEXT,
  -- sha256(workspace, provider, connection, match tier + key, payload hash).
  idempotency_key TEXT,
  playbook_run_id TEXT REFERENCES playbook_runs(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Set just before a create/update is sent. A retry after it is a reconcile.
  write_attempted_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  result_record_id TEXT,
  error_code TEXT,
  last_error TEXT,
  prepared_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((idempotency_key IS NULL) = (payload_hash IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contact_upserts_idempotency
  ON crm_contact_upserts(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_contact_upserts_lead
  ON crm_contact_upserts(workspace_id, lead_contact_id, connection_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_contact_upserts_executing
  ON crm_contact_upserts(workspace_id, connection_id, lead_contact_id)
  WHERE status = 'executing';
