import { z } from 'zod/v3';

/**
 * Explicit attestation before lifting an uncertain LinkedIn action's
 * duplicate-send quarantine. The declaration is not provider-side proof;
 * it creates an auditable owner decision, never an automatic retry.
 */
export const linkedinUnknownResolutionRequest = z.discriminatedUnion('resolution', [
  z
    .object({
      resolution: z.literal('retry'),
      verifiedNotSent: z.literal(true),
      verificationMethod: z.enum(['linkedin_sent_items', 'recipient_confirmed', 'other_verified'])
    })
    .strict(),
  z.object({ resolution: z.literal('sent') }).strict(),
  z.object({ resolution: z.literal('skip') }).strict()
]);
