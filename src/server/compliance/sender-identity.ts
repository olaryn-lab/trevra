import { z } from 'zod/v3';
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';

/* ---------------------------------------------------------------------------
 * WHO THIS WORKSPACE'S COMMERCIAL EMAIL SAYS IT IS FROM.
 *
 * Deterministic plan blockers, never a model's judgement: an email outreach
 * plan cannot be prepared while the postal address or the privacy policy URL
 * is missing. The outreach footer is built from the same row
 * (./provider.ts). Not legal advice; verify with counsel.
 * ------------------------------------------------------------------------ */

export const FTC_CAN_SPAM_GUIDE_URL =
  'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business';

const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface SenderIdentity {
  legalName: string | null;
  postalAddress: string | null;
  privacyPolicyUrl: string | null;
  /** Null until the workspace first saves one. */
  updatedAt: string | null;
}

export interface SenderIdentityBlocker {
  code: 'sender_postal_address_missing' | 'sender_privacy_url_missing';
  message: string;
  actionHref: string;
}

/** Trimmed; a blank string clears the field. */
function blankToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Absent = unchanged, null or blank = cleared. */
export const senderIdentitySchema = z
  .object({
    legalName: z.preprocess(blankToNull, z.string().max(200).nullable()).optional(),
    postalAddress: z.preprocess(blankToNull, z.string().max(500).nullable()).optional(),
    privacyPolicyUrl: z
      .preprocess(
        blankToNull,
        z
          .string()
          .max(2048)
          .url()
          .refine((value) => value.startsWith('https://'), {
            message: 'The privacy policy URL must start with https://'
          })
          .nullable()
      )
      .optional()
  })
  .strict();

interface SenderIdentityRow {
  legal_name: string | null;
  postal_address: string | null;
  privacy_policy_url: string | null;
  updated_at: string;
}

export async function getSenderIdentity(db: Db, workspaceId: string): Promise<SenderIdentity> {
  const row = await db
    .prepare(
      `SELECT legal_name, postal_address, privacy_policy_url,
              TO_CHAR(updated_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS updated_at
       FROM workspace_sender_identities WHERE workspace_id=?`
    )
    .get<SenderIdentityRow>(workspaceId);
  return {
    legalName: row?.legal_name ?? null,
    postalAddress: row?.postal_address ?? null,
    privacyPolicyUrl: row?.privacy_policy_url ?? null,
    updatedAt: row?.updated_at ?? null
  };
}

const FIELDS = [
  ['legalName', 'legal_name'],
  ['postalAddress', 'postal_address'],
  ['privacyPolicyUrl', 'privacy_policy_url']
] as const;

export async function saveSenderIdentity(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; input: unknown },
  now: Date
): Promise<SenderIdentity> {
  const patch = senderIdentitySchema.parse(input.input);
  return db.transaction(async (tx) => {
    // FOR UPDATE locks nothing while no row exists, so two first saves would
    // both merge onto an empty identity and the later one would drop the
    // other's fields. Create the row first; a racing save waits on it.
    const created = await tx
      .prepare(
        `INSERT INTO workspace_sender_identities (workspace_id, created_at, updated_at)
         VALUES (?,?,?) ON CONFLICT (workspace_id) DO NOTHING RETURNING workspace_id`
      )
      .get<{ workspace_id: string }>(input.workspaceId, now.toISOString(), now.toISOString());
    const current = await tx
      .prepare(
        `SELECT legal_name, postal_address, privacy_policy_url
         FROM workspace_sender_identities WHERE workspace_id=? FOR UPDATE`
      )
      .get<Omit<SenderIdentityRow, 'updated_at'>>(input.workspaceId);
    const next = {
      legal_name: current?.legal_name ?? null,
      postal_address: current?.postal_address ?? null,
      privacy_policy_url: current?.privacy_policy_url ?? null
    };
    const changed: string[] = [];
    for (const [field, column] of FIELDS) {
      const value = patch[field];
      if (value === undefined || value === next[column]) continue;
      next[column] = value;
      changed.push(field);
    }
    if (changed.length === 0) {
      // A save that changes nothing leaves no identity behind, not an empty one.
      if (created)
        await tx
          .prepare('DELETE FROM workspace_sender_identities WHERE workspace_id=?')
          .run(input.workspaceId);
      return getSenderIdentity(tx, input.workspaceId);
    }

    await tx
      .prepare(
        `INSERT INTO workspace_sender_identities
           (workspace_id, legal_name, postal_address, privacy_policy_url, updated_by_user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           legal_name=EXCLUDED.legal_name,
           postal_address=EXCLUDED.postal_address,
           privacy_policy_url=EXCLUDED.privacy_policy_url,
           updated_by_user_id=EXCLUDED.updated_by_user_id,
           updated_at=EXCLUDED.updated_at`
      )
      .run(
        input.workspaceId,
        next.legal_name,
        next.postal_address,
        next.privacy_policy_url,
        input.actorUserId,
        now.toISOString(),
        now.toISOString()
      );
    // Field NAMES only: an address is the workspace's own data, not an event's.
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'workspace',
      streamId: input.workspaceId,
      eventType: 'sender_identity.updated',
      actorType: input.actorUserId ? 'user' : 'system',
      actorId: input.actorUserId,
      payload: { fields: changed },
      occurredAt: now
    });
    return getSenderIdentity(tx, input.workspaceId);
  });
}

/** What blocks commercial email in this identity. Pure, so the provider and the store agree. */
export function identityBlockers(identity: SenderIdentity): SenderIdentityBlocker[] {
  const blockers: SenderIdentityBlocker[] = [];
  if (!identity.postalAddress)
    blockers.push({
      code: 'sender_postal_address_missing',
      message: `Add this workspace's postal address before Trevra plans email outreach. Commercial email must carry a valid physical postal address (FTC CAN-SPAM guide: ${FTC_CAN_SPAM_GUIDE_URL}).`,
      actionHref: '/setup/workspace'
    });
  if (!identity.privacyPolicyUrl)
    blockers.push({
      code: 'sender_privacy_url_missing',
      message:
        "Add this workspace's privacy policy URL before Trevra plans email outreach, so every recipient can see who handles their data.",
      actionHref: '/setup/workspace'
    });
  return blockers;
}
