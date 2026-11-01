import type { Db } from '../db.js';
import { id } from '../db.js';
import {
  canonicalLinkedinUrl,
  displayValue,
  isCrmContactProvider,
  normalizeEmail,
  type CrmContactField,
  type CrmContactProviderKey
} from './contact-fields.js';
import { CrmUpsertError } from './contact-providers.js';
import type { CrmMatchTier } from './contact-upsert-payload.js';

/** Workspace-scoped reads and writes shared by prepare and execute (TRV-051). */

export interface CrmConnection {
  id: string;
  provider: CrmContactProviderKey;
  providerConfigKey: string;
  externalConnectionId: string;
  displayName: string | null;
}

interface ConnectionRow {
  id: string;
  provider: string;
  provider_config_key: string;
  external_connection_id: string;
  display_name: string | null;
  status: string;
  is_demo: number | boolean;
}

function usableConnection(row: ConnectionRow | undefined, connectionId: string): CrmConnection {
  if (!row)
    throw new CrmUpsertError(
      'That CRM connection does not exist in this workspace.',
      'crm_connection_not_found',
      404
    );
  if (!isCrmContactProvider(row.provider))
    throw new CrmUpsertError(
      `CRM contact sync is not supported for ${row.provider}. Supported: HubSpot, Attio.`,
      'crm_provider_unsupported',
      422
    );
  if (row.status !== 'connected')
    throw new CrmUpsertError(
      `The ${row.provider} connection is ${row.status}. Reconnect it before syncing contacts.`,
      'crm_not_connected',
      409
    );
  if (Number(row.is_demo) === 1 || row.is_demo === true)
    throw new CrmUpsertError(
      'Demo CRM connections cannot receive contact writes. Connect a real CRM.',
      'crm_provider_unsupported',
      422
    );
  return {
    id: connectionId,
    provider: row.provider,
    providerConfigKey: row.provider_config_key,
    externalConnectionId: row.external_connection_id,
    displayName: row.display_name
  };
}

const CONNECTION_COLUMNS =
  'id,provider,provider_config_key,external_connection_id,display_name,status,is_demo';

/** One connection by id, or the workspace's single real HubSpot/Attio connection. */
export async function resolveCrmConnection(
  db: Db,
  workspaceId: string,
  connectionId?: string | null
): Promise<CrmConnection> {
  if (connectionId) {
    const row = await db
      .prepare(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id=? AND id=?`)
      .get<ConnectionRow>(workspaceId, connectionId);
    return usableConnection(row, connectionId);
  }
  const rows = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS} FROM connections
       WHERE workspace_id=? AND status='connected' AND provider IN ('hubspot','attio')
         AND is_demo=0
       ORDER BY updated_at DESC`
    )
    .all<ConnectionRow>(workspaceId);
  if (rows.length === 0)
    throw new CrmUpsertError(
      'No CRM is connected. Connect HubSpot or Attio first.',
      'crm_not_connected',
      409
    );
  if (rows.length > 1)
    throw new CrmUpsertError(
      'More than one CRM is connected; choose which one to sync to.',
      'crm_connection_required',
      400
    );
  return usableConnection(rows[0], rows[0]!.id);
}

/** Trevra's side of the identity: display values, plus normalized match keys. */
export interface LeadIdentity {
  leadContactId: string;
  personId: string | null;
  values: Partial<Record<CrmContactField, string>>;
}

interface LeadRow {
  id: string;
  person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  profile_url: string | null;
  custom_fields_json: unknown;
  person_email: string | null;
  person_phone: string | null;
  person_role: string | null;
  person_linkedin_url: string | null;
}

function customTitle(custom: unknown): string | null {
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return null;
  const record = custom as Record<string, unknown>;
  for (const key of ['title', 'job_title', 'jobTitle', 'jobtitle', 'position', 'headline']) {
    const value = displayValue(record[key]);
    if (value) return value;
  }
  return null;
}

export async function loadLeadIdentity(
  db: Db,
  workspaceId: string,
  leadContactId: string
): Promise<LeadIdentity> {
  const row = await db
    .prepare(
      `SELECT lc.id, lc.person_id, lc.first_name, lc.last_name, lc.company, lc.email, lc.phone,
              lc.profile_url, lc.custom_fields_json,
              p.email AS person_email, p.phone AS person_phone, p.role AS person_role,
              p.linkedin_url AS person_linkedin_url
       FROM linkedin_lead_contacts lc
       LEFT JOIN contacts p ON p.workspace_id=lc.workspace_id AND p.id=lc.person_id
       WHERE lc.workspace_id=? AND lc.id=?`
    )
    .get<LeadRow>(workspaceId, leadContactId);
  if (!row) throw new CrmUpsertError('Lead not found.', 'lead_not_found', 404);
  const values: Partial<Record<CrmContactField, string>> = {};
  const assign = (field: CrmContactField, value: string | null) => {
    if (value) values[field] = value;
  };
  assign('firstName', displayValue(row.first_name));
  assign('lastName', displayValue(row.last_name));
  assign('company', displayValue(row.company));
  const email = normalizeEmail(row.email) ?? normalizeEmail(row.person_email);
  assign('email', email);
  assign('phone', displayValue(row.phone) ?? displayValue(row.person_phone));
  assign(
    'linkedinUrl',
    canonicalLinkedinUrl(row.profile_url) ?? canonicalLinkedinUrl(row.person_linkedin_url)
  );
  assign('title', displayValue(row.person_role) ?? customTitle(row.custom_fields_json));
  return { leadContactId: row.id, personId: row.person_id, values };
}

export interface CrmContactLink {
  crmRecordId: string;
  matchedBy: string;
  lastSyncedAt: string;
}

/** The stored CRM record for this lead (or its Person) on this connection. */
export async function findCrmContactLink(
  db: Db,
  workspaceId: string,
  connectionId: string,
  lead: { leadContactId: string; personId: string | null }
): Promise<CrmContactLink | null> {
  const row = await db
    .prepare(
      `SELECT crm_record_id, matched_by, last_synced_at FROM crm_contact_links
       WHERE workspace_id=? AND connection_id=?
         AND (lead_contact_id=? OR (?::text IS NOT NULL AND person_id=?))
       ORDER BY (lead_contact_id=?) DESC, last_synced_at DESC LIMIT 1`
    )
    .get<{ crm_record_id: string; matched_by: string; last_synced_at: Date | string }>(
      workspaceId,
      connectionId,
      lead.leadContactId,
      lead.personId,
      lead.personId,
      lead.leadContactId
    );
  if (!row) return null;
  return {
    crmRecordId: row.crm_record_id,
    matchedBy: row.matched_by,
    lastSyncedAt: new Date(row.last_synced_at).toISOString()
  };
}

export async function upsertCrmContactLink(
  tx: Db,
  input: {
    workspaceId: string;
    leadContactId: string;
    provider: string;
    connectionId: string;
    crmRecordId: string;
    matchedBy: CrmMatchTier | 'created';
    now: string;
  }
): Promise<void> {
  // The Person is re-read rather than taken from the payload: a lead can be
  // resolved to a Person between prepare and execute.
  const lead = await tx
    .prepare('SELECT person_id FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
    .get<{ person_id: string | null }>(input.workspaceId, input.leadContactId);
  if (!lead) return;
  await tx
    .prepare(
      `INSERT INTO crm_contact_links (
         id,workspace_id,lead_contact_id,person_id,provider,connection_id,crm_record_id,
         matched_by,last_synced_at,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (workspace_id, connection_id, lead_contact_id) DO UPDATE SET
         person_id=EXCLUDED.person_id, provider=EXCLUDED.provider,
         crm_record_id=EXCLUDED.crm_record_id, matched_by=EXCLUDED.matched_by,
         last_synced_at=EXCLUDED.last_synced_at, updated_at=EXCLUDED.updated_at`
    )
    .run(
      id('crml'),
      input.workspaceId,
      input.leadContactId,
      lead.person_id,
      input.provider,
      input.connectionId,
      input.crmRecordId,
      input.matchedBy,
      input.now,
      input.now,
      input.now
    );
}

export type CrmUpsertStatus =
  | 'prepared'
  | 'blocked_ambiguous'
  | 'up_to_date'
  | 'executing'
  | 'succeeded'
  | 'stale_prepare'
  | 'failed'
  | 'superseded';

export interface CrmUpsertRow {
  id: string;
  workspace_id: string;
  lead_contact_id: string;
  person_id: string | null;
  provider: string;
  connection_id: string;
  status: CrmUpsertStatus;
  operation: 'create' | 'update' | 'none' | null;
  match_tier: CrmMatchTier;
  crm_record_id: string | null;
  candidate_ids_json: unknown;
  plan_json: unknown;
  payload_json: unknown;
  payload_hash: string | null;
  idempotency_key: string | null;
  playbook_run_id: string | null;
  attempts: number;
  write_attempted_at: Date | string | null;
  lease_expires_at: Date | string | null;
  result_record_id: string | null;
  error_code: string | null;
  last_error: string | null;
  prepared_at: Date | string;
  executed_at: Date | string | null;
}

export interface CrmUpsertPlanView {
  identity: Partial<Record<CrmContactField, string>>;
  fields: Partial<Record<CrmContactField, string>>;
  conflicts: Array<{ field: CrmContactField; crmValue: string; trevraValue: string }>;
  skipped: Array<{ field: CrmContactField; reason: string }>;
  tiersSearched: Array<{ tier: CrmMatchTier; outcome: string }>;
  candidates: Array<{ id: string; label: string | null }>;
}

export interface CrmUpsertView {
  id: string;
  leadContactId: string;
  provider: string;
  connectionId: string;
  status: CrmUpsertStatus;
  operation: 'create' | 'update' | 'none' | null;
  matchTier: CrmMatchTier;
  crmRecordId: string | null;
  plan: CrmUpsertPlanView;
  payloadHash: string | null;
  playbookRunId: string | null;
  resultRecordId: string | null;
  errorCode: string | null;
  preparedAt: string;
  executedAt: string | null;
}

const EMPTY_PLAN: CrmUpsertPlanView = {
  identity: {},
  fields: {},
  conflicts: [],
  skipped: [],
  tiersSearched: [],
  candidates: []
};

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function crmUpsertView(row: CrmUpsertRow): CrmUpsertView {
  const plan =
    row.plan_json && typeof row.plan_json === 'object'
      ? { ...EMPTY_PLAN, ...(row.plan_json as Partial<CrmUpsertPlanView>) }
      : EMPTY_PLAN;
  return {
    id: row.id,
    leadContactId: row.lead_contact_id,
    provider: row.provider,
    connectionId: row.connection_id,
    status: row.status,
    operation: row.operation,
    matchTier: row.match_tier,
    crmRecordId: row.crm_record_id,
    plan,
    payloadHash: row.payload_hash,
    playbookRunId: row.playbook_run_id,
    resultRecordId: row.result_record_id,
    errorCode: row.error_code,
    preparedAt: iso(row.prepared_at)!,
    executedAt: iso(row.executed_at)
  };
}

export function crmUpsertLockKey(
  workspaceId: string,
  connectionId: string,
  leadContactId: string
): string {
  return `crm-upsert:${workspaceId}:${connectionId}:${leadContactId}`;
}
