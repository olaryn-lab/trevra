import { z } from 'zod/v3';
import type { Db } from '../db.js';
import { id } from '../db.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import { evaluatePolicy } from '../control-plane/policy.js';
import { getPlaybookRun, startPlaybookRun } from '../playbooks/engine.js';
import type { PlaybookRun } from '../playbooks/types.js';
import {
  CRM_CONTACT_FIELD_MAP,
  CRM_CONTACT_FIELDS,
  isE164,
  isEmptyValue,
  normalizeEmail,
  normalizeField,
  normalizeLinkedinUrl,
  normalizePhone,
  type CrmContactField
} from './contact-fields.js';
import {
  CRM_SEARCH_TIERS,
  contactProviderFor,
  CrmUpsertError,
  nangoCrmHttp,
  searchTier,
  tierKey,
  type CrmContactProvider,
  type CrmContactRecord,
  type CrmHttp,
  type CrmIdentity
} from './contact-providers.js';
import {
  CRM_UPSERT_PLAYBOOK_ID,
  CRM_UPSERT_POLICY_ACTION,
  crmContactUpsertPayloadSchema,
  crmUpsertIdempotencyKey,
  type CrmContactUpsertPayload,
  type CrmMatchTier
} from './contact-upsert-payload.js';
import {
  crmUpsertLockKey,
  crmUpsertView,
  findCrmContactLink,
  loadLeadIdentity,
  resolveCrmConnection,
  type CrmConnection,
  type CrmUpsertPlanView,
  type CrmUpsertRow,
  type CrmUpsertView,
  type LeadIdentity
} from './contact-upsert-store.js';

/**
 * Prepare a `crm.upsert-contact` (TRV-051). Deterministic, no model:
 *
 * 1. the stored link for this lead / Person on this connection, re-read by id;
 * 2. LinkedIn URL, then exact email, then exact first + last name + company,
 *    stopping at the first tier with a match;
 * 3. more than one record in a tier blocks (`blocked_ambiguous`) and writes
 *    nothing; one record plans a fill-empty-only update; none plans a create.
 *
 * The exact payload and its hash go to `crm_contact_upserts`, and a prepared-only
 * playbook run puts it behind founder approval.
 */

export const CRM_UPSERT_BULK_MAX = 100;

export const prepareCrmUpsertSchema = z
  .object({
    leadContactId: z.string().trim().min(1).max(200),
    connectionId: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const prepareCrmUpsertBulkSchema = z
  .object({
    leadContactIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1, 'Choose at least one lead.')
      .max(
        CRM_UPSERT_BULK_MAX,
        `A bulk CRM sync prepares at most ${CRM_UPSERT_BULK_MAX} leads at a time.`
      ),
    connectionId: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export interface PrepareCrmUpsertResult {
  upsert: CrmUpsertView;
  run: PlaybookRun | null;
  /** True when this call created a new approval run. */
  created: boolean;
}

interface Actor {
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
}

type MatchOutcome =
  | { kind: 'matched'; tier: Exclude<CrmMatchTier, 'none'>; key: string; record: CrmContactRecord }
  | {
      kind: 'ambiguous';
      tier: Exclude<CrmMatchTier, 'none'>;
      key: string;
      records: CrmContactRecord[];
    }
  | { kind: 'none' };

function crmIdentity(lead: LeadIdentity): CrmIdentity {
  return {
    linkedinUrl: normalizeLinkedinUrl(lead.values.linkedinUrl),
    email: normalizeEmail(lead.values.email),
    firstName: lead.values.firstName ?? null,
    lastName: lead.values.lastName ?? null,
    company: lead.values.company ?? null
  };
}

async function matchContact(
  provider: CrmContactProvider,
  http: CrmHttp,
  identity: CrmIdentity,
  link: { crmRecordId: string } | null,
  tiersSearched: CrmUpsertPlanView['tiersSearched']
): Promise<MatchOutcome> {
  if (link) {
    const record = await provider.get(link.crmRecordId, http);
    // A merged record answers with the survivor's id; treat the link as stale
    // and let the identity tiers find the survivor on their own evidence.
    if (record && record.id === link.crmRecordId) {
      tiersSearched.push({ tier: 'crm_link', outcome: 'matched' });
      return { kind: 'matched', tier: 'crm_link', key: link.crmRecordId, record };
    }
    tiersSearched.push({ tier: 'crm_link', outcome: record ? 'merged' : 'deleted' });
  }
  for (const tier of CRM_SEARCH_TIERS) {
    const key = tierKey(tier, identity);
    if (!key) {
      tiersSearched.push({ tier, outcome: 'no_key' });
      continue;
    }
    const matches = await searchTier(provider, tier, identity, http);
    if (matches.length === 0) {
      tiersSearched.push({ tier, outcome: 'no_match' });
      continue;
    }
    if (matches.length > 1) {
      tiersSearched.push({ tier, outcome: 'ambiguous' });
      return { kind: 'ambiguous', tier, key, records: matches };
    }
    // Search results can lag the record; plan against a fresh read by id.
    const record = (await provider.get(matches[0]!.id, http)) ?? matches[0]!;
    tiersSearched.push({ tier, outcome: 'matched' });
    return { kind: 'matched', tier, key, record };
  }
  return { kind: 'none' };
}

/** The value Trevra would write for a field, or a reason it will not. */
function writableValue(
  provider: CrmContactProvider,
  field: CrmContactField,
  value: string
): { value: string } | { skip: string } {
  const mapping = CRM_CONTACT_FIELD_MAP[provider.key][field];
  if (!mapping.writable) return { skip: 'not_writable' };
  if (field === 'email') return { value: normalizeEmail(value) ?? value };
  if (mapping.format === 'e164') {
    const phone = normalizePhone(value);
    return phone && isE164(phone) ? { value: phone } : { skip: 'phone_not_e164' };
  }
  return { value };
}

interface Plan {
  operation: 'create' | 'update' | 'none';
  fields: Partial<Record<CrmContactField, string>>;
  conflicts: CrmUpsertPlanView['conflicts'];
  skipped: CrmUpsertPlanView['skipped'];
}

function planUpdate(
  provider: CrmContactProvider,
  values: LeadIdentity['values'],
  record: CrmContactRecord
): Plan {
  const plan: Plan = { operation: 'update', fields: {}, conflicts: [], skipped: [] };
  for (const field of CRM_CONTACT_FIELDS) {
    const trevra = values[field];
    if (!trevra) continue;
    if (field === 'email') {
      // Email is identity: never written to an existing record.
      const normalized = normalizeEmail(trevra);
      if (record.emails.length === 0) plan.skipped.push({ field, reason: 'email_never_written' });
      else if (!normalized || !record.emails.includes(normalized))
        plan.conflicts.push({
          field,
          crmValue: record.values.email ?? record.emails[0]!,
          trevraValue: trevra
        });
      continue;
    }
    const crm = record.values[field];
    if (!isEmptyValue(crm)) {
      if (normalizeField(field, crm) !== normalizeField(field, trevra))
        plan.conflicts.push({ field, crmValue: String(crm).slice(0, 500), trevraValue: trevra });
      continue;
    }
    const writable = writableValue(provider, field, trevra);
    if ('skip' in writable) plan.skipped.push({ field, reason: writable.skip });
    else plan.fields[field] = writable.value;
  }
  if (Object.keys(plan.fields).length === 0) plan.operation = 'none';
  return plan;
}

function planCreate(provider: CrmContactProvider, values: LeadIdentity['values']): Plan {
  const plan: Plan = { operation: 'create', fields: {}, conflicts: [], skipped: [] };
  for (const field of CRM_CONTACT_FIELDS) {
    const trevra = values[field];
    if (!trevra) continue;
    const writable = writableValue(provider, field, trevra);
    if ('skip' in writable) plan.skipped.push({ field, reason: writable.skip });
    else plan.fields[field] = writable.value;
  }
  return plan;
}

const OPEN_STATUSES = ['prepared', 'executing', 'succeeded'];

async function persistBlocked(
  db: Db,
  input: {
    workspaceId: string;
    connection: CrmConnection;
    lead: LeadIdentity;
    status: 'blocked_ambiguous' | 'up_to_date';
    tier: CrmMatchTier;
    recordId: string | null;
    candidates: CrmUpsertPlanView['candidates'];
    plan: CrmUpsertPlanView;
    now: string;
  }
): Promise<CrmUpsertRow> {
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))')
      .get(crmUpsertLockKey(input.workspaceId, input.connection.id, input.lead.leadContactId));
    await supersedeOpen(
      tx,
      input.workspaceId,
      input.connection.id,
      input.lead.leadContactId,
      null,
      input.now
    );
    return (await tx
      .prepare(
        `INSERT INTO crm_contact_upserts (
           id,workspace_id,lead_contact_id,person_id,provider,connection_id,status,operation,
           match_tier,crm_record_id,candidate_ids_json,plan_json,prepared_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`
      )
      .get<CrmUpsertRow>(
        id('crmu'),
        input.workspaceId,
        input.lead.leadContactId,
        input.lead.personId,
        input.connection.provider,
        input.connection.id,
        input.status,
        input.status === 'up_to_date' ? 'none' : null,
        input.tier,
        input.recordId,
        JSON.stringify(input.candidates.map((candidate) => candidate.id)),
        JSON.stringify(input.plan),
        input.now,
        input.now,
        input.now
      ))!;
  });
}

/**
 * Older open prepares for the same lead + connection can no longer execute. A
 * prepared row that already sent a write keeps its state: its outcome is
 * unknown and only its own retry may reconcile it.
 */
async function supersedeOpen(
  tx: Db,
  workspaceId: string,
  connectionId: string,
  leadContactId: string,
  keepId: string | null,
  now: string
): Promise<void> {
  await tx
    .prepare(
      `UPDATE crm_contact_upserts SET status='superseded', lease_expires_at=NULL, updated_at=?
       WHERE workspace_id=? AND connection_id=? AND lead_contact_id=?
         AND (status='blocked_ambiguous' OR (status='prepared' AND write_attempted_at IS NULL))
         AND (?::text IS NULL OR id<>?)`
    )
    .run(now, workspaceId, connectionId, leadContactId, keepId, keepId);
}

async function persistPrepared(
  db: Db,
  input: {
    workspaceId: string;
    connection: CrmConnection;
    lead: LeadIdentity;
    payload: CrmContactUpsertPayload;
    payloadHash: string;
    idempotencyKey: string;
    plan: CrmUpsertPlanView;
    now: string;
  }
): Promise<{ row: CrmUpsertRow; startRun: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))')
      .get(crmUpsertLockKey(input.workspaceId, input.connection.id, input.lead.leadContactId));
    const existing = await tx
      .prepare(
        `SELECT u.*, r.status AS run_status FROM crm_contact_upserts u
         LEFT JOIN playbook_runs r ON r.workspace_id=u.workspace_id AND r.id=u.playbook_run_id
         WHERE u.workspace_id=? AND u.idempotency_key=? FOR UPDATE OF u`
      )
      .get<CrmUpsertRow & { run_status: string | null }>(input.workspaceId, input.idempotencyKey);
    const runIsLive =
      existing?.run_status !== null &&
      existing?.run_status !== undefined &&
      !['completed', 'failed', 'cancelled'].includes(existing.run_status);
    if (
      existing &&
      OPEN_STATUSES.includes(existing.status) &&
      (existing.status === 'succeeded' || runIsLive)
    ) {
      // Same payload already prepared and still moving: return it, start nothing.
      return { row: existing, startRun: false };
    }
    await supersedeOpen(
      tx,
      input.workspaceId,
      input.connection.id,
      input.lead.leadContactId,
      existing?.id ?? null,
      input.now
    );
    if (existing) {
      // A previous run for this exact payload ended (rejected, exhausted retries,
      // stale or refused). Re-arm the same row. `write_attempted_at` is kept
      // when the last outcome was unknown, so the next execution reconciles
      // instead of writing twice.
      const row = await tx
        .prepare(
          `UPDATE crm_contact_upserts SET
             status='prepared', person_id=?, plan_json=?, playbook_run_id=NULL,
             attempts=0, lease_expires_at=NULL, error_code=NULL, last_error=NULL,
             write_attempted_at=CASE WHEN status IN ('prepared','executing') THEN write_attempted_at ELSE NULL END,
             prepared_at=?, updated_at=?
           WHERE id=? RETURNING *`
        )
        .get<CrmUpsertRow>(
          input.lead.personId,
          JSON.stringify(input.plan),
          input.now,
          input.now,
          existing.id
        );
      return { row: row!, startRun: true };
    }
    const row = await tx
      .prepare(
        `INSERT INTO crm_contact_upserts (
           id,workspace_id,lead_contact_id,person_id,provider,connection_id,status,operation,
           match_tier,crm_record_id,plan_json,payload_json,payload_hash,idempotency_key,
           prepared_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?) RETURNING *`
      )
      .get<CrmUpsertRow>(
        id('crmu'),
        input.workspaceId,
        input.lead.leadContactId,
        input.lead.personId,
        input.connection.provider,
        input.connection.id,
        input.payload.operation,
        input.payload.match.tier,
        input.payload.match.recordId,
        JSON.stringify(input.plan),
        JSON.stringify(input.payload),
        input.payloadHash,
        input.idempotencyKey,
        input.now,
        input.now,
        input.now
      );
    return { row: row!, startRun: true };
  });
}

async function prepareForLead(
  db: Db,
  workspaceId: string,
  connection: CrmConnection,
  leadContactId: string,
  actor: Actor,
  http: CrmHttp
): Promise<PrepareCrmUpsertResult> {
  const provider = contactProviderFor(connection.provider);
  const lead = await loadLeadIdentity(db, workspaceId, leadContactId);
  const identity = crmIdentity(lead);
  const now = new Date().toISOString();

  const link = await findCrmContactLink(db, workspaceId, connection.id, lead);
  if (!link && CRM_SEARCH_TIERS.every((tier) => !tierKey(tier, identity)))
    throw new CrmUpsertError(
      'This lead has no LinkedIn URL, email, or name and company to match a CRM contact on.',
      'insufficient_identity',
      422
    );

  const tiersSearched: CrmUpsertPlanView['tiersSearched'] = [];
  const match = await matchContact(provider, http, identity, link, tiersSearched);
  const basePlan = { identity: lead.values, tiersSearched };

  if (match.kind === 'ambiguous') {
    const candidates = match.records.map((record) => ({ id: record.id, label: record.label }));
    const row = await persistBlocked(db, {
      workspaceId,
      connection,
      lead,
      status: 'blocked_ambiguous',
      tier: match.tier,
      recordId: null,
      candidates,
      plan: { ...basePlan, fields: {}, conflicts: [], skipped: [], candidates },
      now
    });
    return { upsert: crmUpsertView(row), run: null, created: false };
  }

  const plan =
    match.kind === 'matched'
      ? planUpdate(provider, lead.values, match.record)
      : planCreate(provider, lead.values);
  const planView: CrmUpsertPlanView = {
    ...basePlan,
    fields: plan.fields,
    conflicts: plan.conflicts,
    skipped: plan.skipped,
    candidates: match.kind === 'matched' ? [{ id: match.record.id, label: match.record.label }] : []
  };

  if (plan.operation === 'none') {
    const row = await persistBlocked(db, {
      workspaceId,
      connection,
      lead,
      status: 'up_to_date',
      tier: match.kind === 'matched' ? match.tier : 'none',
      recordId: match.kind === 'matched' ? match.record.id : null,
      candidates: [],
      plan: planView,
      now
    });
    return { upsert: crmUpsertView(row), run: null, created: false };
  }
  if (
    plan.operation === 'create' &&
    !plan.fields.firstName &&
    !plan.fields.lastName &&
    !plan.fields.email
  )
    throw new CrmUpsertError(
      'A new CRM contact needs a name or an email.',
      'insufficient_identity',
      422
    );

  const payload = crmContactUpsertPayloadSchema.parse({
    provider: connection.provider,
    connectionId: connection.id,
    subject: { leadContactId: lead.leadContactId, personId: lead.personId },
    match:
      match.kind === 'matched'
        ? { tier: match.tier, key: match.key, recordId: match.record.id }
        : { tier: 'none', key: null, recordId: null },
    identity,
    operation: plan.operation,
    fields: plan.fields,
    review: { conflicts: plan.conflicts, skipped: plan.skipped }
  });
  const payloadHash = canonicalPayloadHash(payload);
  const idempotencyKey = crmUpsertIdempotencyKey({
    workspaceId,
    provider: connection.provider,
    connectionId: connection.id,
    tier: payload.match.tier,
    key: payload.match.key,
    payloadHash
  });

  const persisted = await persistPrepared(db, {
    workspaceId,
    connection,
    lead,
    payload,
    payloadHash,
    idempotencyKey,
    plan: planView,
    now
  });
  if (!persisted.startRun) {
    const run = persisted.row.playbook_run_id
      ? await getPlaybookRun(db, workspaceId, persisted.row.playbook_run_id)
      : null;
    return { upsert: crmUpsertView(persisted.row), run, created: false };
  }

  let run: PlaybookRun;
  try {
    run = await startPlaybookRun(db, {
      workspaceId,
      playbookId: CRM_UPSERT_PLAYBOOK_ID,
      payload,
      actorType: actor.actorType,
      actorId: actor.actorId,
      prepared: true
    });
  } catch (error) {
    await db
      .prepare(
        `UPDATE crm_contact_upserts SET status='failed', error_code='prepare_failed', updated_at=?
         WHERE workspace_id=? AND id=? AND status='prepared'`
      )
      .run(new Date().toISOString(), workspaceId, persisted.row.id);
    throw error;
  }
  const row = await db
    .prepare(
      `UPDATE crm_contact_upserts SET playbook_run_id=?, updated_at=?
       WHERE workspace_id=? AND id=? RETURNING *`
    )
    .get<CrmUpsertRow>(run.id, new Date().toISOString(), workspaceId, persisted.row.id);
  return { upsert: crmUpsertView(row!), run, created: true };
}

async function assertPolicyAllows(
  db: Db,
  workspaceId: string,
  connection: CrmConnection,
  actor: Actor
): Promise<void> {
  const decision = await evaluatePolicy(db, {
    workspaceId,
    action: CRM_UPSERT_POLICY_ACTION,
    actorType: actor.actorType,
    actorId: actor.actorId,
    sideEffect: 'external-write',
    playbookId: CRM_UPSERT_PLAYBOOK_ID,
    attributes: { provider: connection.provider }
  });
  if (decision.effect === 'deny')
    throw new CrmUpsertError(
      `Workspace policy blocks CRM contact sync: ${decision.reason}`,
      'policy_denied',
      403
    );
}

export async function prepareCrmContactUpsert(
  db: Db,
  workspaceId: string,
  input: z.infer<typeof prepareCrmUpsertSchema> & Actor
): Promise<PrepareCrmUpsertResult> {
  const connection = await resolveCrmConnection(db, workspaceId, input.connectionId);
  await assertPolicyAllows(db, workspaceId, connection, input);
  const http = nangoCrmHttp({
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.externalConnectionId
  });
  return prepareForLead(db, workspaceId, connection, input.leadContactId, input, http);
}

export interface BulkPrepareItem {
  leadContactId: string;
  upsert: CrmUpsertView | null;
  runId: string | null;
  created: boolean;
  error: { code: string; message: string } | null;
}

/** Up to `CRM_UPSERT_BULK_MAX` leads, one connection, one result per lead. */
export async function prepareCrmContactUpserts(
  db: Db,
  workspaceId: string,
  input: z.infer<typeof prepareCrmUpsertBulkSchema> & Actor
): Promise<{ connectionId: string; provider: string; results: BulkPrepareItem[] }> {
  const leadContactIds = [...new Set(input.leadContactIds)];
  if (leadContactIds.length > CRM_UPSERT_BULK_MAX)
    throw new CrmUpsertError(
      `A bulk CRM sync prepares at most ${CRM_UPSERT_BULK_MAX} leads at a time.`,
      'bulk_limit',
      400
    );
  const connection = await resolveCrmConnection(db, workspaceId, input.connectionId);
  await assertPolicyAllows(db, workspaceId, connection, input);
  const http = nangoCrmHttp({
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.externalConnectionId
  });
  const results: BulkPrepareItem[] = [];
  // lc-debt: sequential per-lead CRM reads (up to ~5 calls x 100 leads); bounded by the cap and
  // provider rate limits; upgrade path is a provider batch-read endpoint plus a bounded pool.
  for (const leadContactId of leadContactIds) {
    try {
      const result = await prepareForLead(db, workspaceId, connection, leadContactId, input, http);
      results.push({
        leadContactId,
        upsert: result.upsert,
        runId: result.run?.id ?? null,
        created: result.created,
        error: null
      });
    } catch (error) {
      if (!(error instanceof CrmUpsertError)) throw error;
      results.push({
        leadContactId,
        upsert: null,
        runId: null,
        created: false,
        error: { code: error.code, message: error.message }
      });
    }
  }
  return { connectionId: connection.id, provider: connection.provider, results };
}
