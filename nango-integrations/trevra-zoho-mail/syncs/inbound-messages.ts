import { createSync } from 'nango';
import * as z from 'zod';
import {
  BACKFILL_MS,
  INBOUND_ADDRESS_METADATA_KEY,
  INBOUND_EMAIL_MESSAGE_MODEL,
  buildInboundRecord,
  headerValue,
  normalizeAddress,
  type InboundEmailRecord,
  type MailHeader
} from '../../shared/inbound-email.js';
import { InboundEmailMessage, InboundSyncMetadata } from '../../shared/inbound-model.js';
import {
  ZOHO_LIST_CEILING,
  ZOHO_LIST_MAX_PAGES,
  ZOHO_LIST_NEWEST_FIRST,
  ZOHO_LIST_PAGE_SIZE,
  ZOHO_MAX_MESSAGES_PER_RUN,
  mimeFromOriginalMessage,
  parseMimeMessage,
  parseZohoHeaders,
  pickZohoAccount,
  pickZohoFolderId,
  zohoListPage,
  zohoNextCheckpoint,
  type ZohoListEntry
} from '../../shared/zoho-mail.js';

const SAVE_BATCH = 50;

export default createSync({
  description:
    'Reads the Zoho Mail inbox Trevra designated for inbound mail. Emits person-to-person mail only; Trevra keeps only senders it already knows.',
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
    const accounts = await nango.get<unknown>({ endpoint: '/api/accounts', retries: 3 });
    const account = pickZohoAccount(accounts.data);
    if (!account || account.address !== expected) {
      throw new Error(
        'This Zoho Mail connection no longer reads the designated inbound address. Designate the mailbox again in Trevra.'
      );
    }
    const base = `/api/accounts/${encodeURIComponent(account.accountId)}`;
    const folders = await nango.get<unknown>({ endpoint: `${base}/folders`, retries: 3 });
    const inboxId = pickZohoFolderId(folders.data, 'inbox');
    if (!inboxId) throw new Error('Trevra could not find the Inbox of this Zoho Mail account.');

    const startedAt = Date.now();
    const checkpoint = await nango.getCheckpoint();
    const sinceMs = checkpoint?.sinceMs ?? startedAt - BACKFILL_MS;
    const listed: ZohoListEntry[] = [];
    const seen = new Set<string>();
    let start = 1;
    let pages = 0;
    let more = true;
    while (more && listed.length < ZOHO_LIST_CEILING && pages < ZOHO_LIST_MAX_PAGES) {
      pages += 1;
      // lc-debt: reads only the Inbox, as the Gmail and Microsoft syncs do; a reply filtered out of the Inbox before the next 15-minute run is never read.
      const page = await nango.get<unknown>({
        endpoint: `${base}/messages/view`,
        params: {
          folderId: inboxId,
          start,
          limit: ZOHO_LIST_PAGE_SIZE,
          sortBy: 'date',
          sortorder: ZOHO_LIST_NEWEST_FIRST
        },
        retries: 3
      });
      const { recent, exhausted } = zohoListPage(page.data, sinceMs);
      for (const entry of recent) {
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        listed.push(entry);
      }
      // lc-debt: stopping relies on received-time order within ZOHO_SORT_SLACK_MS (smoke S5); confirm the sort key in S5 or page by a received-time filter.
      if (exhausted) more = false;
      start += ZOHO_LIST_PAGE_SIZE;
    }
    if (more) {
      // lc-debt: more than ZOHO_LIST_CEILING inbox messages in one window reads only the newest of them, as the Gmail sync does.
      await nango.log(
        `Inbox listing hit its bound (${ZOHO_LIST_CEILING} messages or ${ZOHO_LIST_MAX_PAGES} pages) since the last run; reading the newest messages found.`,
        { level: 'warn' }
      );
    }

    // Read oldest first so the checkpoint can resume.
    const queue = [...listed]
      .sort((left, right) => left.receivedMs - right.receivedMs)
      .slice(0, ZOHO_MAX_MESSAGES_PER_RUN);
    let batch: InboundEmailRecord[] = [];
    let lastMs = sinceMs;
    let partial = 0;
    let headerless = 0;
    for (const entry of queue) {
      const messageId = encodeURIComponent(entry.messageId);
      let headers: MailHeader[] = [];
      let body = entry.summary;
      try {
        const original = await nango.get<unknown>({
          endpoint: `${base}/messages/${messageId}/originalmessage`,
          retries: 3
        });
        const raw = mimeFromOriginalMessage(original.data);
        if (raw) {
          const parsed = parseMimeMessage(raw);
          headers = parsed.headers;
          if (parsed.text) body = parsed.text;
        }
      } catch {
        // Falls through to the header request and the list summary.
      }
      if (headers.length === 0) {
        partial += 1;
        try {
          const header = await nango.get<unknown>({
            endpoint: `${base}/folders/${encodeURIComponent(inboxId)}/messages/${messageId}/header`,
            retries: 3
          });
          headers = parseZohoHeaders(header.data);
        } catch {
          headerless += 1;
        }
      }
      // lc-debt: emits the body of every person-to-person message, as the Gmail sync does; Trevra keeps only known senders server-side.
      const record = buildInboundRecord({
        id: entry.messageId,
        mailboxAddress: expected,
        from: headerValue(headers, 'From') ?? entry.fromAddress,
        subject: headerValue(headers, 'Subject') ?? entry.subject,
        body,
        occurredAt: entry.receivedMs,
        externalUrl: null,
        internetMessageId: headerValue(headers, 'Message-ID'),
        headers
      });
      if (record) batch.push(record);
      lastMs = Math.max(lastMs, entry.receivedMs);
      if (batch.length >= SAVE_BATCH) {
        await nango.batchSave(batch, INBOUND_EMAIL_MESSAGE_MODEL);
        batch = [];
        await nango.saveCheckpoint({ sinceMs: lastMs - 1000 });
      }
    }
    if (batch.length > 0) await nango.batchSave(batch, INBOUND_EMAIL_MESSAGE_MODEL);
    if (partial > 0 || headerless > 0) {
      await nango.log(
        `Zoho Mail returned ${partial} message(s) without full content and ${headerless} without headers; used list summaries instead.`,
        { level: 'warn' }
      );
    }
    const finished = queue.length === listed.length && !more;
    await nango.saveCheckpoint({
      sinceMs: zohoNextCheckpoint({ finished, sinceMs, startedAt, lastMs })
    });
  }
});
