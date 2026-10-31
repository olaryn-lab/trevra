import { z } from 'zod/v3';
import {
  actionAttachmentViolation,
  checkRichContent,
  workflowRichContentViolation,
  type RichAttachmentInput,
  type RichContentChannel,
  type RichContentStepLike
} from '../../shared/rich-content.js';
import { LinkedInApiError, richContentError, richContentRefusalDetails } from './errors.js';

/**
 * TRV-040 server enforcement of `src/shared/rich-content.ts`.
 *
 * NOT IN THE ZOD SCHEMAS ON PURPOSE. `parseWorkflowSteps` and every stored
 * campaign snapshot are read through `workflowStepsSchema`; a refusal there
 * would make a legacy workflow that carries (say) an invitation attachment
 * unreadable instead of held. Writes call these assertions after parsing;
 * reads keep parsing, and the runner and the local worker hold what the
 * matrix refuses.
 */

/** One attachment as an API caller describes it. */
export const richAttachmentInputSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2000)
      .refine((value) => value.startsWith('https://'), 'Attachment URLs must use HTTPS.')
      .nullable()
      .optional(),
    name: z.string().trim().max(255).nullable().optional(),
    mimeType: z.string().trim().max(255).nullable().optional(),
    sizeBytes: z.number().int().min(0).nullable().optional(),
    mediaKind: z.enum(['file', 'gif', 'voice']).nullable().optional()
  })
  .strict();
export type RichAttachmentRequest = z.infer<typeof richAttachmentInputSchema>;

/** Bounded only so a request cannot be made arbitrarily large; the matrix decides the real count. */
export const richAttachmentListSchema = z.array(richAttachmentInputSchema).max(20);

export function assertRichContent(
  channel: RichContentChannel,
  attachments: readonly RichAttachmentInput[]
): void {
  const violation = checkRichContent(channel, attachments);
  if (violation) throw richContentError(violation);
}

/** Every variant attachment in these steps, against its step's channel. */
export function assertWorkflowRichContent(steps: readonly RichContentStepLike[]): void {
  const violation = workflowRichContentViolation(steps);
  if (!violation) return;
  const where = `Step ${violation.stepId}${violation.variantId ? `, variant ${violation.variantId.toUpperCase()}` : ''}`;
  throw new LinkedInApiError(
    `${where}: ${violation.reason}`,
    violation.code === 'attachment_too_large' ? 413 : 422,
    violation.code,
    {
      ...richContentRefusalDetails(violation),
      stepId: violation.stepId,
      variantId: violation.variantId
    }
  );
}

/** A stored or proposed `linkedin_actions.attachment_json` against the row's kind. */
export function assertActionAttachment(kind: string, attachment: unknown): void {
  const violation = actionAttachmentViolation(kind, attachment);
  if (violation) throw richContentError(violation);
}

/**
 * The single object `attachment_json` stores and the driver consumes, from an
 * admissible request. Call only after `assertRichContent` accepted the list.
 */
export function storedAttachmentOf(
  attachments: readonly RichAttachmentRequest[]
): Record<string, unknown> | null {
  const first = attachments[0];
  if (!first) return null;
  if (!first.url) throw new LinkedInApiError('An attachment needs an HTTPS URL to download.', 400);
  return {
    url: first.url,
    name: first.name ?? null,
    mediaKind: first.mediaKind ?? 'file',
    ...(first.mimeType ? { mimeType: first.mimeType } : {}),
    ...(typeof first.sizeBytes === 'number' ? { sizeBytes: first.sizeBytes } : {})
  };
}
