import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { CRM_CONTACT_FIELDS, CRM_CONTACT_PROVIDERS } from './contact-fields.js';

/**
 * The exact payload a founder approves for `crm.upsert-contact` (TRV-051).
 *
 * Kept in its own module so the playbook registry, the execution registry and
 * the prepare path share one schema without importing each other. The schema
 * has no defaults or transforms: what prepare hashes is what the engine hashes.
 * There is deliberately no top-level `body`, so the generic approval-body edit
 * cannot touch it.
 */

export const CRM_UPSERT_PLAYBOOK_ID = 'gtm.crm-upsert-contact';
export const CRM_UPSERT_APPROVAL_STEP_ID = 'approve-crm-upsert';
export const CRM_UPSERT_POLICY_ACTION = 'action:crm.upsert-contact';

export const CRM_MATCH_TIERS = [
  'crm_link',
  'linkedin_url',
  'email',
  'name_company',
  'none'
] as const;
export type CrmMatchTier = (typeof CRM_MATCH_TIERS)[number];

const fieldSchema = z.enum(CRM_CONTACT_FIELDS);
const shortText = z.string().min(1).max(500);
const nullableText = z.string().min(1).max(500).nullable();

export const crmContactUpsertPayloadSchema = z
  .object({
    provider: z.enum(CRM_CONTACT_PROVIDERS),
    /** Local `connections.id`, never the provider's connection reference. */
    connectionId: z.string().min(1).max(200),
    subject: z
      .object({
        leadContactId: z.string().min(1).max(200),
        personId: z.string().min(1).max(200).nullable()
      })
      .strict(),
    match: z
      .object({
        tier: z.enum(CRM_MATCH_TIERS),
        /** Normalized key of the matching tier; the record id for `crm_link`. */
        key: z.string().min(1).max(1600).nullable(),
        recordId: z.string().min(1).max(200).nullable()
      })
      .strict(),
    /** What execution re-searches with before a create. Email and URL normalized. */
    identity: z
      .object({
        linkedinUrl: nullableText,
        email: nullableText,
        firstName: nullableText,
        lastName: nullableText,
        company: nullableText
      })
      .strict(),
    operation: z.enum(['create', 'update']),
    /** Create: every field. Update: only fields empty in the CRM at prepare. */
    fields: z.record(fieldSchema, shortText),
    review: z
      .object({
        conflicts: z
          .array(
            z.object({ field: fieldSchema, crmValue: shortText, trevraValue: shortText }).strict()
          )
          .max(CRM_CONTACT_FIELDS.length),
        skipped: z
          .array(z.object({ field: fieldSchema, reason: z.string().min(1).max(300) }).strict())
          .max(CRM_CONTACT_FIELDS.length)
      })
      .strict()
  })
  .strict()
  .superRefine((payload, context) => {
    if (Object.keys(payload.fields).length === 0)
      context.addIssue({ code: 'custom', message: 'A CRM upsert must write at least one field.' });
    if (
      payload.operation === 'update' &&
      (!payload.match.recordId || payload.match.tier === 'none')
    )
      context.addIssue({ code: 'custom', message: 'An update needs the matched CRM record.' });
    if (payload.operation === 'update' && payload.fields.email !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'Email is never written to an existing record.'
      });
    if (payload.operation === 'create' && (payload.match.tier !== 'none' || payload.match.recordId))
      context.addIssue({ code: 'custom', message: 'A create has no matched record.' });
  });

export type CrmContactUpsertPayload = z.infer<typeof crmContactUpsertPayloadSchema>;

/**
 * sha256(workspace, provider, connection, match tier + key, payload hash). The
 * unit separator keeps fields from running into each other.
 */
export function crmUpsertIdempotencyKey(input: {
  workspaceId: string;
  provider: string;
  connectionId: string;
  tier: CrmMatchTier;
  key: string | null;
  payloadHash: string;
}): string {
  return createHash('sha256')
    .update(
      [
        'crm.upsert-contact',
        input.workspaceId,
        input.provider,
        input.connectionId,
        `${input.tier}:${input.key ?? ''}`,
        input.payloadHash
      ].join('\u001f')
    )
    .digest('hex');
}
