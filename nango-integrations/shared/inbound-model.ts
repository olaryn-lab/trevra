import * as z from 'zod';
import { INBOUND_ADDRESS_METADATA_KEY } from './inbound-email.js';

/**
 * Field-for-field the InboundEmailRecord type in ./inbound-email.ts, which is
 * itself Trevra's canonical `message` record plus the inbound mailbox fields.
 * The sync registers it under the name INBOUND_EMAIL_MESSAGE_MODEL.
 */
export const InboundEmailMessage = z.object({
  id: z.string(),
  kind: z.literal('message'),
  direction: z.literal('inbound'),
  mailboxAddress: z.string(),
  personEmail: z.string(),
  personName: z.string().optional(),
  subject: z.string(),
  body: z.string(),
  occurredAt: z.string(),
  externalUrl: z.string().optional(),
  internetMessageId: z.string().optional(),
  replyToMessageIds: z.array(z.string()),
  autoSubmitted: z.string().nullable()
});

/** Written by Trevra (designateInboundMailbox) before it starts the sync. */
export const InboundSyncMetadata = z.object({
  [INBOUND_ADDRESS_METADATA_KEY]: z.string()
});
