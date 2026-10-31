import type { Db } from '../db.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import {
  isEmptyValue,
  normalizeEmail,
  normalizeField,
  type CrmContactField
} from './contact-fields.js';
import {
  contactProviderFor,
  CRM_SEARCH_TIERS,
  CrmUpsertError,
  nangoCrmHttp,
  recordStillMatches,
  searchTier,
  staleError,
  type CrmContactProvider,
  type CrmContactRecord,
  type CrmHttp
} from './contact-providers.js';
import {
  crmContactUpsertPayloadSchema,
  crmUpsertIdempotencyKey,
  type CrmContactUpsertPayload,
  type CrmMatchTier
} from './contact-upsert-payload.js';
import {
  crmUpsertLockKey,
  resolveCrmConnection,
  upsertCrmContactLink,
  type CrmUpsertRow
} from './contact-upsert-store.js';

/**
 * Execute an approved `crm.upsert-contact` (TRV-051).
 *
 * The ledger row is claimed under an advisory lock plus `FOR UPDATE` and held in
 * `executing` with a lease, so two workers cannot write the same upsert. The CRM
 * is re-read right before the write; anything that moved since prepare (a
 * planned field filled, the record deleted or merged, a match appearing for a
 * create) refuses with `stale_prepare` and writes nothing.
 *
 * Neither HubSpot nor Attio takes an idempotency key on create, and their
 * upsert endpoints overwrite values, which fill-empty-only forbids. So a create
 * is search-before-create inside the claimed execution, and each provider's
 * unique email turns a lost-response retry into a conflict Trevra reconciles
 * (`write_attempted_at`) instead of a duplicate contact.
 */

const LEASE_MS = 10 * 60_000;

export interface CrmUpsertDelivery {
  provider: string;
  externalRef: string;
  reused: boolean;
}

interface Claim {
  row: CrmUpsertRow;
  priorWrite: boolean;
  reusedRecordId: string | null;
}

function terminal(message: string, code: string, status = 409): CrmUpsertError {
  return new CrmUpsertError(message, code, status);
}

async function claim(
  db: Db,
  workspaceId: string,
  payload: CrmContactUpsertPayload,
  payloadHash: string,
  idempotencyKey: string
): Promise<Claim> {
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))')
      .get(crmUpsertLockKey(workspaceId, payload.connectionId, payload.subject.leadContactId));
    const row = await tx
      .prepare(
        'SELECT * FROM crm_contact_upserts WHERE workspace_id=? AND idempotency_key=? FOR UPDATE'
      )
      .get<CrmUpsertRow>(workspaceId, idempotencyKey);
    if (!row)
      throw terminal(
        'No prepared CRM sync matches this approved payload; nothing was written.',
        'not_prepared'
      );
    if (row.payload_hash !== payloadHash || canonicalPayloadHash(row.payload_json) !== payloadHash)
      throw terminal(
        'The approved payload does not match the prepared CRM sync; nothing was written.',
        'payload_hash_mismatch'
      );
    if (row.status === 'succeeded' && row.result_record_id)
      return { row, priorWrite: true, reusedRecordId: row.result_record_id };
    if (row.status !== 'prepared' && row.status !== 'executing')
      throw terminal(
        `This CRM sync is ${row.status}; prepare it again. Nothing was written.`,
        row.status
      );
    const now = new Date();
    if (
      row.status === 'executing' &&
      row.lease_expires_at &&
      new Date(row.lease_expires_at).getTime() > now.getTime()
    )
      throw new CrmUpsertError(
        'This CRM sync is already running.',
        'crm_upsert_in_progress',
        409,
        true
      );
    const sibling = await tx
      .prepare(
        `SELECT id FROM crm_contact_upserts
         WHERE workspace_id=? AND connection_id=? AND lead_contact_id=? AND id<>?
           AND status='executing' AND lease_expires_at > ?`
      )
      .get<{ id: string }>(
        workspaceId,
        payload.connectionId,
        payload.subject.leadContactId,
        row.id,
        now.toISOString()
      );
    if (sibling)
      throw new CrmUpsertError(
        'Another CRM sync for this lead is running.',
        'crm_upsert_in_progress',
        409,
        true
      );
    const claimed = await tx
      .prepare(
        `UPDATE crm_contact_upserts SET status='executing', attempts=attempts+1,
           lease_expires_at=?, error_code=NULL, last_error=NULL, updated_at=?
         WHERE id=? RETURNING *`
      )
      .get<CrmUpsertRow>(
        new Date(now.getTime() + LEASE_MS).toISOString(),
        now.toISOString(),
        row.id
      );
    return { row: claimed!, priorWrite: row.write_attempted_at !== null, reusedRecordId: null };
  });
}

async function markWriteAttempted(db: Db, workspaceId: string, rowId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE crm_contact_upserts SET write_attempted_at=COALESCE(write_attempted_at, ?), updated_at=?
       WHERE workspace_id=? AND id=? AND status='executing'`
    )
    .run(new Date().toISOString(), new Date().toISOString(), workspaceId, rowId);
}

/** Does the record already hold every value this payload plans to write? */
function recordCarries(
  provider: CrmContactProvider,
  record: CrmContactRecord,
  fields: CrmContactUpsertPayload['fields']
): boolean {
  return (Object.entries(fields) as Array<[CrmContactField, string]>).every(([field, value]) => {
    if (field === 'email') return record.emails.includes(normalizeEmail(value) ?? '');
    if (field === 'company' && !provider.readsCompanyText) return true;
    return normalizeField(field, record.values[field]) === normalizeField(field, value);
  });
}

async function executeUpdate(
  db: Db,
  workspaceId: string,
  provider: CrmContactProvider,
  http: CrmHttp,
  payload: CrmContactUpsertPayload,
  claimed: Claim
): Promise<string> {
  const recordId = payload.match.recordId!;
  const record = await provider.get(recordId, http);
  if (!record) throw staleError('The CRM record was deleted.');
  if (record.id !== recordId) throw staleError('The CRM record was merged into another record.');
  const tier = payload.match.tier as Exclude<CrmMatchTier, 'none'>;
  if (tier !== 'crm_link' && !recordStillMatches(provider, tier, payload.identity, record))
    throw staleError(`The CRM record no longer matches on ${tier}.`);
  const toWrite: Partial<Record<CrmContactField, string>> = {};
  for (const [field, value] of Object.entries(payload.fields) as Array<[CrmContactField, string]>) {
    const current = record.values[field];
    if (isEmptyValue(current)) toWrite[field] = value;
    // Equal after an earlier attempt sent the write: that value is Trevra's own.
    else if (claimed.priorWrite && normalizeField(field, current) === normalizeField(field, value))
      continue;
    else throw staleError(`The CRM ${field} was filled after prepare.`);
  }
  if (Object.keys(toWrite).length > 0) {
    await markWriteAttempted(db, workspaceId, claimed.row.id);
    await provider.update(record, toWrite, http);
  }
  return record.id;
}

async function executeCreate(
  db: Db,
  workspaceId: string,
  provider: CrmContactProvider,
  http: CrmHttp,
  payload: CrmContactUpsertPayload,
  claimed: Claim
): Promise<string> {
  const adopt = (records: CrmContactRecord[]): string | null =>
    claimed.priorWrite &&
    records.length === 1 &&
    recordCarries(provider, records[0]!, payload.fields)
      ? records[0]!.id
      : null;
  for (const tier of CRM_SEARCH_TIERS) {
    const matches = await searchTier(provider, tier, payload.identity, http);
    if (matches.length === 0) continue;
    // A retry after an unknown outcome finds its own earlier create.
    const adopted = adopt(matches);
    if (adopted) return adopted;
    throw staleError(`A CRM contact matching on ${tier} appeared after prepare.`);
  }
  await markWriteAttempted(db, workspaceId, claimed.row.id);
  const created = await provider.create(payload.fields, http);
  if (created.kind === 'created') return created.id;
  const existing = created.existingId ? await provider.get(created.existingId, http) : null;
  const candidates = existing
    ? [existing]
    : await searchTier(provider, 'email', payload.identity, http);
  const adopted = adopt(candidates);
  if (adopted) return adopted;
  throw staleError('A CRM contact with this email already exists.');
}

async function settle(
  db: Db,
  workspaceId: string,
  rowId: string,
  status: 'prepared' | 'failed' | 'stale_prepare',
  code: string,
  message: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE crm_contact_upserts SET status=?, error_code=?, last_error=?, lease_expires_at=NULL,
         updated_at=? WHERE workspace_id=? AND id=? AND status='executing'`
    )
    .run(
      status,
      code.slice(0, 120),
      message.slice(0, 500),
      new Date().toISOString(),
      workspaceId,
      rowId
    );
}

export async function executeCrmContactUpsert(
  db: Db,
  input: { workspaceId: string; payload: unknown; payloadHash: string }
): Promise<CrmUpsertDelivery> {
  const parsed = crmContactUpsertPayloadSchema.safeParse(input.payload);
  if (!parsed.success)
    throw terminal('The CRM sync payload is invalid; nothing was written.', 'invalid_payload', 422);
  const payload = parsed.data;
  if (canonicalPayloadHash(payload) !== input.payloadHash)
    throw terminal(
      'The approved payload does not match the prepared CRM sync; nothing was written.',
      'payload_hash_mismatch'
    );

  const provider = contactProviderFor(payload.provider);
  const connection = await resolveCrmConnection(db, input.workspaceId, payload.connectionId);
  if (connection.provider !== payload.provider)
    throw terminal(
      'The CRM connection no longer belongs to the approved provider; nothing was written.',
      'crm_connection_changed'
    );
  const idempotencyKey = crmUpsertIdempotencyKey({
    workspaceId: input.workspaceId,
    provider: payload.provider,
    connectionId: payload.connectionId,
    tier: payload.match.tier,
    key: payload.match.key,
    payloadHash: input.payloadHash
  });

  const http = nangoCrmHttp({
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.externalConnectionId
  });
  const claimed = await claim(db, input.workspaceId, payload, input.payloadHash, idempotencyKey);
  if (claimed.reusedRecordId)
    return { provider: payload.provider, externalRef: claimed.reusedRecordId, reused: true };

  let recordId: string;
  try {
    recordId =
      payload.operation === 'update'
        ? await executeUpdate(db, input.workspaceId, provider, http, payload, claimed)
        : await executeCreate(db, input.workspaceId, provider, http, payload, claimed);
  } catch (error) {
    if (error instanceof CrmUpsertError) {
      const status =
        error.code === 'stale_prepare' ? 'stale_prepare' : error.retryable ? 'prepared' : 'failed';
      await settle(db, input.workspaceId, claimed.row.id, status, error.code, error.message);
    } else {
      await settle(
        db,
        input.workspaceId,
        claimed.row.id,
        'prepared',
        'unexpected_error',
        'The CRM sync failed unexpectedly; it will be retried.'
      );
    }
    throw error;
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE crm_contact_upserts SET status='succeeded', result_record_id=?, executed_at=?,
           lease_expires_at=NULL, error_code=NULL, last_error=NULL, updated_at=?
         WHERE workspace_id=? AND id=?`
      )
      .run(recordId, now, now, input.workspaceId, claimed.row.id);
    await upsertCrmContactLink(tx, {
      workspaceId: input.workspaceId,
      leadContactId: payload.subject.leadContactId,
      provider: payload.provider,
      connectionId: payload.connectionId,
      crmRecordId: recordId,
      matchedBy: payload.operation === 'create' ? 'created' : payload.match.tier,
      now
    });
  });
  return { provider: payload.provider, externalRef: recordId, reused: false };
}
