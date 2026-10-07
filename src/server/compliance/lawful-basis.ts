import { z } from 'zod';
import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { RECIPIENT_SQL, recipientSchema } from '../email/recipient-sql.js';
import { findSuppression } from '../suppressions.js';
import { ComplianceError } from './errors.js';
import {
  JURISDICTION_RULES_DISCLAIMER,
  LAWFUL_BASES,
  decideEmailLawfulBasis,
  normalizeCountryCode,
  resolveRecipientCountry,
  type EmailPurpose,
  type LawfulBasis,
  type LawfulBasisDecision
} from './jurisdiction-rules.js';

/* ---------------------------------------------------------------------------
 * PER-PERSON, PER-CHANNEL LAWFUL BASIS, with its source and timestamp.
 *
 * Rows are withdrawn, never deleted, so "why did Trevra send this" keeps an
 * answer. Every query is scoped by workspace. Recording a basis can unblock
 * cold email, so the routes keep it owner-only; a withdrawal only ever blocks.
 * Not legal advice; verify with counsel.
 * ------------------------------------------------------------------------ */

export const LAWFUL_BASIS_CHANNELS = ['email', 'linkedin'] as const;
export type LawfulBasisChannel = (typeof LAWFUL_BASIS_CHANNELS)[number];
export type LawfulBasisSource = 'inbound_capture' | 'operator';

// lc-debt: ceiling of 500 people checked per lead-list plan; upgrade path is a
// set-based count once the rule table is mirrored in SQL.
export const LEAD_LIST_BASIS_CHECK_LIMIT = 500;

const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const RECORD_COLUMNS = `id, person_id, channel, basis, source, source_ref,
  TO_CHAR(recorded_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS recorded_at,
  TO_CHAR(withdrawn_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS withdrawn_at`;

export interface LawfulBasisRecord {
  id: string;
  personId: string;
  channel: LawfulBasisChannel;
  basis: LawfulBasis;
  source: LawfulBasisSource;
  sourceRef: string | null;
  recordedAt: string;
  withdrawnAt: string | null;
}

interface LawfulBasisRow {
  id: string;
  person_id: string;
  channel: LawfulBasisChannel;
  basis: LawfulBasis;
  source: LawfulBasisSource;
  source_ref: string | null;
  recorded_at: string;
  withdrawn_at: string | null;
}

function toRecord(row: LawfulBasisRow): LawfulBasisRecord {
  return {
    id: row.id,
    personId: row.person_id,
    channel: row.channel,
    basis: row.basis,
    source: row.source,
    sourceRef: row.source_ref,
    recordedAt: row.recorded_at,
    withdrawnAt: row.withdrawn_at
  };
}

export const lawfulBasisInputSchema = z
  .object({
    channel: z.enum(LAWFUL_BASIS_CHANNELS),
    basis: z.enum(LAWFUL_BASES),
    sourceRef: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const countryInputSchema = z.object({ countryCode: z.string().max(60).nullable() }).strict();

function actorTypeOf(actorUserId: string | null | undefined): 'user' | 'system' {
  return actorUserId ? 'user' : 'system';
}

export async function recordLawfulBasis(
  db: Db,
  input: {
    workspaceId: string;
    personId: string;
    channel: LawfulBasisChannel;
    basis: LawfulBasis;
    source: LawfulBasisSource;
    sourceRef?: string | null;
    /** When the basis came into being. Defaults to `now`. */
    recordedAt?: string;
    actorUserId?: string | null;
  },
  now: Date
): Promise<{ record: LawfulBasisRecord; created: boolean }> {
  const person = await db
    .prepare('SELECT id FROM contacts WHERE workspace_id=? AND id=?')
    .get<{ id: string }>(input.workspaceId, input.personId);
  if (!person) throw new ComplianceError('Person not found', 404);

  const sourceRef = input.sourceRef ?? null;
  const inserted = await db
    .prepare(
      `INSERT INTO contact_lawful_bases
         (id, workspace_id, person_id, channel, basis, source, source_ref, recorded_at, recorded_by_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?::timestamptz,?,?::timestamptz)
       ON CONFLICT (workspace_id, person_id, channel, basis, source, (COALESCE(source_ref, '')))
         WHERE withdrawn_at IS NULL DO NOTHING
       RETURNING id`
    )
    .get<{ id: string }>(
      id('clb'),
      input.workspaceId,
      input.personId,
      input.channel,
      input.basis,
      input.source,
      sourceRef,
      input.recordedAt ?? now.toISOString(),
      input.actorUserId ?? null,
      now.toISOString()
    );
  const row = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM contact_lawful_bases
       WHERE workspace_id=? AND person_id=? AND channel=? AND basis=? AND source=?
         AND COALESCE(source_ref, '')=? AND withdrawn_at IS NULL`
    )
    .get<LawfulBasisRow>(
      input.workspaceId,
      input.personId,
      input.channel,
      input.basis,
      input.source,
      sourceRef ?? ''
    );
  if (!row)
    throw new ComplianceError(
      'That lawful basis changed while it was being recorded. Try again.',
      409
    );
  if (inserted)
    await appendDomainEvent(db, {
      workspaceId: input.workspaceId,
      streamType: 'contact',
      streamId: input.personId,
      eventType: 'lawful_basis.recorded',
      actorType: actorTypeOf(input.actorUserId),
      actorId: input.actorUserId ?? null,
      payload: {
        lawfulBasisId: row.id,
        channel: input.channel,
        basis: input.basis,
        source: input.source
      },
      occurredAt: now
    });
  return { record: toRecord(row), created: Boolean(inserted) };
}

/** Idempotent: withdrawing a withdrawn basis returns it unchanged. */
export async function withdrawLawfulBasis(
  db: Db,
  input: { workspaceId: string; lawfulBasisId: string; actorUserId: string | null },
  now: Date
): Promise<LawfulBasisRecord> {
  const updated = await db
    .prepare(
      `UPDATE contact_lawful_bases SET withdrawn_at=?::timestamptz, withdrawn_by_user_id=?
       WHERE workspace_id=? AND id=? AND withdrawn_at IS NULL
       RETURNING id`
    )
    .get<{ id: string }>(
      now.toISOString(),
      input.actorUserId,
      input.workspaceId,
      input.lawfulBasisId
    );
  const row = await db
    .prepare(`SELECT ${RECORD_COLUMNS} FROM contact_lawful_bases WHERE workspace_id=? AND id=?`)
    .get<LawfulBasisRow>(input.workspaceId, input.lawfulBasisId);
  if (!row) throw new ComplianceError('Lawful basis not found', 404);
  if (updated)
    await appendDomainEvent(db, {
      workspaceId: input.workspaceId,
      streamType: 'contact',
      streamId: row.person_id,
      eventType: 'lawful_basis.withdrawn',
      actorType: actorTypeOf(input.actorUserId),
      actorId: input.actorUserId,
      payload: { lawfulBasisId: row.id, channel: row.channel, basis: row.basis },
      occurredAt: now
    });
  return toRecord(row);
}

export async function listLawfulBases(
  db: Db,
  workspaceId: string,
  personId: string
): Promise<LawfulBasisRecord[]> {
  const rows = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM contact_lawful_bases
       WHERE workspace_id=? AND person_id=?
       ORDER BY recorded_at ASC, id ASC`
    )
    .all<LawfulBasisRow>(workspaceId, personId);
  return rows.map(toRecord);
}

function countryOrRefuse(countryCode: string | null): string | null {
  if (countryCode === null || countryCode.trim() === '') return null;
  const code = normalizeCountryCode(countryCode);
  if (!code)
    throw new ComplianceError(
      'Use a two-letter ISO country code such as DE or US, or leave the country empty.',
      400
    );
  return code;
}

export async function setContactCountry(
  db: Db,
  input: {
    workspaceId: string;
    personId: string;
    countryCode: string | null;
    actorUserId: string | null;
  },
  now: Date
): Promise<{ countryCode: string | null }> {
  const countryCode = countryOrRefuse(input.countryCode);
  const row = await db
    .prepare(
      `UPDATE contacts SET country_code=?, updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? RETURNING id`
    )
    .get<{ id: string }>(countryCode, now.toISOString(), input.workspaceId, input.personId);
  if (!row) throw new ComplianceError('Person not found', 404);
  await appendDomainEvent(db, {
    workspaceId: input.workspaceId,
    streamType: 'contact',
    streamId: input.personId,
    eventType: 'contact.country_set',
    actorType: actorTypeOf(input.actorUserId),
    actorId: input.actorUserId,
    payload: { countryCode },
    occurredAt: now
  });
  return { countryCode };
}

export async function setAccountCountry(
  db: Db,
  input: {
    workspaceId: string;
    accountId: string;
    countryCode: string | null;
    actorUserId: string | null;
  },
  now: Date
): Promise<{ countryCode: string | null }> {
  const countryCode = countryOrRefuse(input.countryCode);
  const row = await db
    .prepare(
      `UPDATE accounts SET country_code=?, updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? RETURNING id`
    )
    .get<{ id: string }>(countryCode, now.toISOString(), input.workspaceId, input.accountId);
  if (!row) throw new ComplianceError('Account not found', 404);
  await appendDomainEvent(db, {
    workspaceId: input.workspaceId,
    streamType: 'account',
    streamId: input.accountId,
    eventType: 'account.country_set',
    actorType: actorTypeOf(input.actorUserId),
    actorId: input.actorUserId,
    payload: { countryCode },
    occurredAt: now
  });
  return { countryCode };
}

export interface EmailRecipientInput {
  email: string;
  /** The canonical person, when the caller knows it; otherwise matched by email. */
  personId?: string | null;
  /** `linkedin_lead_contacts.country`, as imported. */
  leadCountry?: string | null;
  purpose?: EmailPurpose;
}

interface RecipientFactsRow {
  ord: number;
  contact_country: string | null;
  account_country: string | null;
  account_domain: string | null;
  bases: unknown;
  has_inbound_email: boolean | null;
  has_inbound_request: boolean | null;
}

/**
 * One decision per input, in input order, from ONE statement. Every table is
 * read inside `workspaceId`; an unmatched address is an unknown person in an
 * unknown country, which the rule table treats as needing a basis.
 */
export async function evaluateEmailLawfulBases(
  db: Db,
  workspaceId: string,
  inputs: readonly EmailRecipientInput[]
): Promise<LawfulBasisDecision[]> {
  if (inputs.length === 0) return [];
  const rows = await db
    .prepare(
      `
      WITH input AS (
        SELECT ord::int AS ord, LOWER(TRIM(email)) AS email, NULLIF(person_id, '') AS person_id
        FROM unnest(?::text[], ?::text[]) WITH ORDINALITY AS t(email, person_id, ord)
      )
      SELECT i.ord,
             c.country_code AS contact_country,
             acct.country_code AS account_country,
             acct.domain AS account_domain,
             COALESCE((
               SELECT jsonb_agg(DISTINCT b.basis) FROM contact_lawful_bases b
               WHERE b.workspace_id=? AND b.person_id=c.id AND b.channel='email' AND b.withdrawn_at IS NULL
             ), '[]'::jsonb) AS bases,
             EXISTS (
               SELECT 1 FROM conversation_messages m
               JOIN conversations cv ON cv.id=m.conversation_id AND cv.workspace_id=m.workspace_id
               WHERE cv.workspace_id=? AND cv.person_id=c.id AND m.channel='email' AND m.direction='inbound'
             ) AS has_inbound_email,
             EXISTS (
               SELECT 1 FROM inbound_submissions s WHERE s.workspace_id=? AND s.contact_id=c.id
             ) AS has_inbound_request
      FROM input i
      LEFT JOIN contacts c
        ON c.workspace_id=?
       AND ((i.person_id IS NOT NULL AND c.id=i.person_id
             AND (c.email_normalized=i.email
               OR EXISTS (
                 SELECT 1 FROM linkedin_lead_contacts l
                 WHERE l.workspace_id=c.workspace_id AND l.person_id=c.id
                   AND LOWER(BTRIM(l.email))=i.email)))
         OR c.email_normalized=i.email)
      LEFT JOIN LATERAL (
        SELECT a.country_code, a.domain
        FROM account_contacts ac
        JOIN accounts a ON a.workspace_id=ac.workspace_id AND a.id=ac.account_id
        WHERE ac.workspace_id=? AND ac.contact_id=c.id
        ORDER BY CASE ac.confidence WHEN 'explicit' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END,
                 a.updated_at DESC, a.id ASC
        LIMIT 1
      ) acct ON TRUE
      ORDER BY i.ord, (c.id=i.person_id) DESC NULLS LAST, c.id
    `
    )
    .all<RecipientFactsRow>(
      inputs.map((input) => input.email),
      inputs.map((input) => input.personId ?? null),
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId
    );
  // A bound personId sorts first; keep the first row per input.
  const byOrd = new Map<number, RecipientFactsRow>();
  for (const row of rows) if (!byOrd.has(Number(row.ord))) byOrd.set(Number(row.ord), row);
  return inputs.map((input, index) => {
    const row = byOrd.get(index + 1);
    const resolved = resolveRecipientCountry({
      contactCountry: row?.contact_country ?? null,
      leadCountry: input.leadCountry ?? null,
      accountCountry: row?.account_country ?? null,
      accountDomain: row?.account_domain ?? null
    });
    return decideEmailLawfulBasis({
      email: input.email.trim().toLowerCase(),
      country: resolved.country,
      countrySource: resolved.source,
      bases: Array.isArray(row?.bases) ? row.bases.map(String) : [],
      purpose: input.purpose ?? 'outreach',
      hasInboundEmail: row?.has_inbound_email === true,
      hasInboundRequest: row?.has_inbound_request === true
    });
  });
}

export async function evaluateEmailLawfulBasis(
  db: Db,
  workspaceId: string,
  input: EmailRecipientInput
): Promise<LawfulBasisDecision> {
  return (await evaluateEmailLawfulBases(db, workspaceId, [input]))[0]!;
}

function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Every address the send could reach: the de-duplicated, normalized union of
 * `recipients`, `to` and `recipient` (execution sends to `payload.recipient`).
 */
function recipientsOf(source: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const key of ['recipients', 'to', 'recipient']) {
    const value = source[key];
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries)
      if (typeof entry === 'string' && entry.trim() !== '') found.add(entry.trim().toLowerCase());
  }
  return [...found];
}

/**
 * Policy attributes for an `email.send` payload. Computed from the database
 * for the payload's RECIPIENTS; a status the payload claims for itself is
 * never read. Returns `{}` when there is nobody to send to.
 */
export async function emailLawfulBasisAttributes(
  db: Db,
  workspaceId: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  const source = plainObject(payload);
  const recipients = recipientsOf(source);
  if (recipients.length === 0) return {};
  const metadata = plainObject(source.metadata);
  const purpose: EmailPurpose =
    metadata.deliveryPurpose === 'reply'
      ? 'reply'
      : metadata.deliverySourceType === 'qualified_demand'
        ? 'qualified_demand'
        : 'outreach';
  const personId =
    recipients.length === 1 && typeof metadata.personId === 'string' && metadata.personId.trim()
      ? metadata.personId.trim()
      : null;
  // Outreach payloads carry the lead contact id. Reading its country here keeps
  // plan time and send time on the same resolution (contact, lead list, account,
  // account domain, unknown).
  const contactId =
    recipients.length === 1 && typeof metadata.contactId === 'string' && metadata.contactId.trim()
      ? metadata.contactId.trim()
      : null;
  // The lead must be this recipient (by address, or by the Person bound to it).
  const leadCountry = contactId
    ? ((
        await db
          .prepare(
            `SELECT l.country FROM linkedin_lead_contacts l
             WHERE l.workspace_id=? AND l.id=?
               AND (LOWER(BTRIM(l.email))=?
                 OR EXISTS (
                   SELECT 1 FROM contacts c
                   WHERE c.workspace_id=l.workspace_id AND c.id=l.person_id AND c.email_normalized=?))`
          )
          .get<{ country: string | null }>(workspaceId, contactId, recipients[0], recipients[0])
      )?.country ?? null)
    : null;
  const decisions = await evaluateEmailLawfulBases(
    db,
    workspaceId,
    recipients.map((email) => ({ email, personId, leadCountry, purpose }))
  );
  const missing = decisions.filter((decision) => decision.status === 'missing');
  return {
    lawfulBasisStatus: missing.length > 0 ? 'missing' : 'covered',
    lawfulBasisReason: missing[0]?.reason ?? null,
    recipientsMissingBasis: missing.length
  };
}

/**
 * How many of the people outreach would write to lack a basis for cold email.
 * It selects the same rows `prepareEmailOutreach` (email/outreach.ts) would
 * prepare: person email first, no do-not-contact, no suppression, and none it
 * skips as `already_contacted` (an outreach delivery to that address is
 * sending, sent or uncertain) or `already_pending` (an open gtm.email-outreach
 * run for the Person, or an earlier member of this list with the same address
 * or Person). So the count equals the set that would actually be sent.
 */
export async function countLeadListMissingEmailBasis(
  db: Db,
  workspaceId: string,
  listId: string
): Promise<{ checked: number; missing: number; truncated: boolean }> {
  const rows = await db
    .prepare(
      `SELECT lc.person_id, lc.country, ${RECIPIENT_SQL} AS recipient
       FROM linkedin_lead_list_members m
       JOIN linkedin_lead_contacts lc ON lc.workspace_id=m.workspace_id AND lc.id=m.contact_id
       LEFT JOIN contacts p ON p.workspace_id=lc.workspace_id AND p.id=lc.person_id
       WHERE m.workspace_id=? AND m.list_id=? AND lc.do_not_contact=FALSE
         AND lc.person_id IS NOT NULL AND ${RECIPIENT_SQL} IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM gtm_deliveries d
           WHERE d.workspace_id=m.workspace_id AND d.channel='email' AND d.purpose='outreach'
             AND d.status IN ('sending','sent','uncertain')
             AND LOWER(d.recipient)=${RECIPIENT_SQL})
         AND NOT EXISTS (
           SELECT 1 FROM playbook_runs r
           WHERE r.workspace_id=m.workspace_id AND r.playbook_key='gtm.email-outreach'
             AND r.status IN ('queued','running','waiting_approval')
             AND r.input_json->>'personId'=lc.person_id)
       ORDER BY m.created_at ASC, lc.id ASC
       LIMIT ?::int`
    )
    .all<{ person_id: string; country: string | null; recipient: string }>(
      workspaceId,
      listId,
      LEAD_LIST_BASIS_CHECK_LIMIT + 1
    );
  const window = rows.slice(0, LEAD_LIST_BASIS_CHECK_LIMIT);
  const checked: typeof window = [];
  const recipients = new Set<string>();
  const people = new Set<string>();
  for (const row of window) {
    if (!recipientSchema.safeParse(row.recipient).success) continue;
    // The same address or Person earlier in this list is prepared once.
    if (recipients.has(row.recipient) || people.has(row.person_id)) continue;
    // lc-debt: N suppression lookups per check; upgrade path: set-based NOT EXISTS against suppressions
    const suppressed = await findSuppression(db, workspaceId, {
      channel: 'email',
      personId: row.person_id,
      email: row.recipient
    });
    if (suppressed) continue;
    checked.push(row);
    recipients.add(row.recipient);
    people.add(row.person_id);
  }
  const decisions = await evaluateEmailLawfulBases(
    db,
    workspaceId,
    checked.map((row) => ({
      email: row.recipient,
      personId: row.person_id,
      leadCountry: row.country,
      purpose: 'outreach' as const
    }))
  );
  return {
    checked: checked.length,
    missing: decisions.filter((decision) => decision.status === 'missing').length,
    truncated: rows.length > LEAD_LIST_BASIS_CHECK_LIMIT
  };
}

export async function personComplianceView(db: Db, workspaceId: string, personId: string) {
  const person = await db
    .prepare('SELECT id, email, country_code FROM contacts WHERE workspace_id=? AND id=?')
    .get<{ id: string; email: string | null; country_code: string | null }>(workspaceId, personId);
  if (!person) throw new ComplianceError('Person not found', 404);
  return {
    personId: person.id,
    countryCode: person.country_code,
    emailDecision: person.email
      ? await evaluateEmailLawfulBasis(db, workspaceId, {
          email: person.email,
          personId: person.id
        })
      : null,
    lawfulBases: await listLawfulBases(db, workspaceId, person.id),
    disclaimer: JURISDICTION_RULES_DISCLAIMER
  };
}
