-- TRV-051: which CRM record a Trevra lead / Person is, per CRM connection.
--
-- Written only after a `crm.upsert-contact` execution the CRM confirmed. Later
-- prepares look here first and re-read the stored record id before searching by
-- LinkedIn URL, email or name + company.
--
-- Closed by cascade with the lead, the Person, the connection or the workspace;
-- a link that no longer resolves in the CRM is replaced on the next confirmed
-- upsert.

CREATE TABLE IF NOT EXISTS crm_contact_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  person_id TEXT,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  crm_record_id TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN (
    'crm_link','linkedin_url','email','name_company','created'
  )),
  last_synced_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contact_links_lead
  ON crm_contact_links(workspace_id, connection_id, lead_contact_id);

CREATE INDEX IF NOT EXISTS idx_crm_contact_links_person
  ON crm_contact_links(workspace_id, connection_id, person_id)
  WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_contact_links_record
  ON crm_contact_links(workspace_id, connection_id, crm_record_id);
