import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  INBOUND_ADDRESS_METADATA_KEY,
  INBOUND_EMAIL_MESSAGE_MODEL,
  MAX_MESSAGES_PER_RUN,
  OVERLAP_MS,
  buildInboundRecord,
  decodePartData,
  headerValue,
  htmlToText,
  normalizeAddress,
  type InboundEmailRecord,
  type MailHeader
} from '../../shared/inbound-email.js';
import { InboundEmailMessage, InboundSyncMetadata } from '../../shared/inbound-model.js';

/** Message ids listed per run before the oldest-first read. */
const LIST_CEILING = 2000;
const SAVE_BATCH = 50;

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: MailHeader[];
};

type GmailMessage = {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

function partText(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return decodePartData(part.body.data, part.headers);
  }
  for (const child of part.parts ?? []) {
    const found = partText(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function messageBody(message: GmailMessage): string {
  const plain = partText(message.payload, 'text/plain');
  if (plain !== null) return plain.trim();
  const html = partText(message.payload, 'text/html');
  if (html !== null) return htmlToText(html);
  return (message.snippet ?? '').trim();
}

export default createSync({
  description:
    'Reads the Gmail inbox Trevra designated for inbound mail. Emits person-to-person mail only; Trevra keeps only senders it already knows.',
  version: '1.0.0',
  frequency: 'every 15 minutes',
  autoStart: false,
  models: { InboundEmailMessage },
  metadata: InboundSyncMetadata,
  checkpoint: z.object({ sinceMs: z.number() }),
  exec: async (nango) => {
    const metadata = await nango.getMetadata();
    const expected = normalizeAddress(metadata?.[INBOUND_ADDRESS_METADATA_KEY]);
    if (!expected) {
      throw new Error('trevraInboundAddress metadata is missing. Designate the mailbox in Trevra.');
    }
    const profile = await nango.get<{ emailAddress?: string }>({
      endpoint: '/gmail/v1/users/me/profile',
      retries: 3
    });
    if (normalizeAddress(profile.data.emailAddress) !== expected) {
      throw new Error(
        'This Gmail connection no longer reads the designated inbound address. Designate the mailbox again in Trevra.'
      );
    }

    const startedAt = Date.now();
    const checkpoint = await nango.getCheckpoint();
    const sinceMs = checkpoint?.sinceMs ?? startedAt - BACKFILL_MS;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      // lc-debt: reads only the inbox at run time; a reply archived or filtered out of the inbox before the next 15-minute run is never read. Upgrade path: query all mail minus sent/drafts/spam/trash (Gmail) or /me/messages excluding those folders (Graph), after deciding the wider stranger-mail exposure in Nango.
      const page = await nango.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>({
        endpoint: '/gmail/v1/users/me/messages',
        params: {
          q: `in:inbox -category:promotions -category:social after:${Math.floor(sinceMs / 1000)}`,
          maxResults: 100,
          ...(pageToken ? { pageToken } : {})
        },
        retries: 3
      });
      for (const message of page.data.messages ?? []) ids.push(message.id);
      pageToken = page.data.nextPageToken;
    } while (pageToken && ids.length < LIST_CEILING);
    if (pageToken) {
      // lc-debt: more than LIST_CEILING inbox messages in one window reads only the newest LIST_CEILING of them; upgrade path: list by bounded after:/before: date windows.
      await nango.log(
        `More than ${LIST_CEILING} inbox messages since the last run; reading the newest ${LIST_CEILING}.`,
        {
          level: 'warn'
        }
      );
    }

    // Gmail lists newest first; read oldest first so the checkpoint can resume.
    const queue = ids.reverse().slice(0, MAX_MESSAGES_PER_RUN);
    let batch: InboundEmailRecord[] = [];
    let lastMs = sinceMs;
    for (const id of queue) {
      const response = await nango.get<GmailMessage>({
        endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
        params: { format: 'full' },
        retries: 3
      });
      const message = response.data;
      const headers = message.payload?.headers ?? [];
      const occurredMs = Number(message.internalDate ?? Number.NaN);
      // lc-debt: emits the body of every person-to-person message, including ones that are not replies to Trevra deliveries (Nango retains them until the connection is deleted); these should be headers-only records. Upgrade path: filter by reply metadata (In-Reply-To/References against Trevra delivery ids) in the sync.
      const record = buildInboundRecord({
        id: message.id,
        mailboxAddress: expected,
        from: headerValue(headers, 'From'),
        subject: headerValue(headers, 'Subject'),
        body: messageBody(message),
        occurredAt: Number.isFinite(occurredMs) ? occurredMs : null,
        externalUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(expected)}#all/${encodeURIComponent(message.id)}`,
        internetMessageId: headerValue(headers, 'Message-ID'),
        headers
      });
      if (record) batch.push(record);
      if (Number.isFinite(occurredMs)) lastMs = Math.max(lastMs, occurredMs);
      if (batch.length >= SAVE_BATCH) {
        await nango.batchSave(batch, INBOUND_EMAIL_MESSAGE_MODEL);
        batch = [];
        await nango.saveCheckpoint({ sinceMs: lastMs - 1000 });
      }
    }
    if (batch.length > 0) await nango.batchSave(batch, INBOUND_EMAIL_MESSAGE_MODEL);
    const finished = queue.length === ids.length && !pageToken;
    await nango.saveCheckpoint({
      sinceMs: finished ? Math.max(sinceMs, startedAt - OVERLAP_MS) : lastMs - 1000
    });
  }
});
