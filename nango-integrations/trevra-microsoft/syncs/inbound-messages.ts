import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  INBOUND_EMAIL_MESSAGE_MODEL,
  MAX_MESSAGES_PER_RUN,
  buildInboundRecord,
  htmlToText,
  normalizeAddress,
  type InboundEmailRecord,
  type MailHeader
} from '../../shared/inbound-email.js';
import { InboundEmailMessage, InboundSyncMetadata } from '../../shared/inbound-model.js';

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  subject?: string | null;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  webLink?: string;
  internetMessageHeaders?: MailHeader[];
};

function fromHeader(message: GraphMessage): string | null {
  const address = message.from?.emailAddress?.address;
  if (!address) return null;
  const name = (message.from?.emailAddress?.name ?? '').replace(/["<>]/g, '').trim();
  return name ? `"${name}" <${address}>` : address;
}

function graphBody(message: GraphMessage): string {
  const content = message.body?.content ?? '';
  return message.body?.contentType === 'html' ? htmlToText(content) : content.trim();
}

export default createSync({
  description:
    'Reads the Microsoft 365 inbox Trevra designated for inbound mail. Emits person-to-person mail only; Trevra keeps only senders it already knows.',
  version: '1.0.0',
  frequency: 'every 15 minutes',
  autoStart: false,
  models: { InboundEmailMessage },
  metadata: InboundSyncMetadata,
  checkpoint: z.object({ since: z.string() }),
  exec: async (nango) => {
    const metadata = await nango.getMetadata();
    const expected = normalizeAddress(metadata?.trevraInboundAddress);
    if (!expected) {
      throw new Error('trevraInboundAddress metadata is missing. Designate the mailbox in Trevra.');
    }
    const me = await nango.get<{ mail?: string | null; userPrincipalName?: string | null }>({
      endpoint: '/v1.0/me',
      params: { $select: 'mail,userPrincipalName' },
      retries: 3
    });
    if (normalizeAddress(me.data.mail || me.data.userPrincipalName) !== expected) {
      throw new Error(
        'This Microsoft 365 connection no longer reads the designated inbound address. Designate the mailbox again in Trevra.'
      );
    }

    const checkpoint = await nango.getCheckpoint();
    const since = checkpoint?.since ?? new Date(Date.now() - BACKFILL_MS).toISOString();
    let latestMs = Date.parse(since);
    let read = 0;
    for await (const page of nango.paginate<GraphMessage>({
      endpoint: '/v1.0/me/mailFolders/inbox/messages',
      // Immutable ids keep a record's id stable when the user files the message.
      headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
      params: {
        $filter: `receivedDateTime ge ${since}`,
        $orderby: 'receivedDateTime asc',
        $select:
          'id,internetMessageId,subject,body,from,receivedDateTime,webLink,internetMessageHeaders'
      },
      paginate: {
        type: 'link',
        link_path_in_response_body: '@odata.nextLink',
        response_path: 'value',
        limit_name_in_request: '$top',
        limit: 50
      },
      retries: 3
    })) {
      const records: InboundEmailRecord[] = [];
      for (const message of page) {
        const record = buildInboundRecord({
          id: message.id,
          mailboxAddress: expected,
          from: fromHeader(message),
          subject: message.subject ?? '',
          body: graphBody(message),
          occurredAt: message.receivedDateTime ?? null,
          externalUrl: message.webLink ?? null,
          internetMessageId: message.internetMessageId ?? null,
          headers: message.internetMessageHeaders ?? []
        });
        if (record) records.push(record);
        const receivedMs = Date.parse(message.receivedDateTime ?? '');
        if (Number.isFinite(receivedMs)) latestMs = Math.max(latestMs, receivedMs);
      }
      if (records.length > 0) await nango.batchSave(records, INBOUND_EMAIL_MESSAGE_MODEL);
      // `ge` re-reads the boundary message next run; record ids make that idempotent.
      await nango.saveCheckpoint({ since: new Date(latestMs).toISOString() });
      read += page.length;
      if (read >= MAX_MESSAGES_PER_RUN) break;
    }
  }
});
