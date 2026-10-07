import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  INBOUND_ADDRESS_METADATA_KEY,
  INBOUND_EMAIL_MESSAGE_MODEL,
  MAX_MESSAGES_PER_RUN,
  OVERLAP_MS,
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
    const expected = normalizeAddress(metadata?.[INBOUND_ADDRESS_METADATA_KEY]);
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

    const startedAt = Date.now();
    const checkpoint = await nango.getCheckpoint();
    const since = checkpoint?.since ?? new Date(startedAt - BACKFILL_MS).toISOString();
    const sinceMs = Date.parse(since);
    let latestMs = sinceMs;
    let read = 0;
    let exhausted = true;
    // lc-debt: reads only the inbox at run time; a reply archived or filtered out of the inbox before the next 15-minute run is never read. Upgrade path: query all mail minus sent/drafts/spam/trash (Gmail) or /me/messages excluding those folders (Graph), after deciding the wider stranger-mail exposure in Nango.
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
        // lc-debt: emits the body of every person-to-person message, including ones that are not replies to Trevra deliveries (Nango retains them until the connection is deleted); these should be headers-only records. Upgrade path: filter by reply metadata (In-Reply-To/References against Trevra delivery ids) in the sync.
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
      if (read >= MAX_MESSAGES_PER_RUN) {
        exhausted = false;
        break;
      }
    }
    if (exhausted) {
      // Re-read the last few minutes next run for late-indexed mail, like Gmail.
      await nango.saveCheckpoint({
        since: new Date(Math.max(sinceMs, Math.min(latestMs, startedAt - OVERLAP_MS))).toISOString()
      });
    }
  }
});
