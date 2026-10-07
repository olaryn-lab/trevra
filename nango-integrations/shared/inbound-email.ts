/*
 * Pure helpers shared by the trevra-gmail and trevra-microsoft inbound-messages
 * syncs. No imports on purpose: Nango bundles this file into each function,
 * and the Trevra repo type-checks and tests it
 * (src/server/email/inbound-sync-helpers.test.ts). Only `Buffer` and JS
 * built-ins are available inside Nango's sandbox.
 */

/** Must equal INBOUND_SYNC_NAME in src/server/email/inbound-mailbox.ts (parity-tested). */
export const INBOUND_SYNC_NAME = 'inbound-messages';
/** Must equal INBOUND_EMAIL_MESSAGE_MODEL in src/server/email/inbound-mailbox.ts (parity-tested). */
export const INBOUND_EMAIL_MESSAGE_MODEL = 'InboundEmailMessage';
/** Must equal INBOUND_ADDRESS_METADATA_KEY in src/server/email/channel.ts (parity-tested). */
export const INBOUND_ADDRESS_METADATA_KEY = 'trevraInboundAddress';

/** The first run reads this far back. */
export const BACKFILL_MS = 3 * 24 * 60 * 60 * 1000;
/** Each completed run re-reads this much before its start, for late-indexed mail. */
export const OVERLAP_MS = 5 * 60 * 1000;
/** At most this many messages per run; the checkpoint resumes the rest. */
export const MAX_MESSAGES_PER_RUN = 500;
export const MAX_BODY_CHARS = 20_000;
export const MAX_REPLY_TO_IDS = 50;

/**
 * Mirror of zod 3.25's `z.string().email()` pattern. Trevra validates
 * personEmail with it, and one invalid record would fail the whole webhook
 * batch, so the sync only emits addresses this accepts.
 */
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

/** Mirror of UNSUBSCRIBE_SUBJECT_PATTERN in src/server/email/unsubscribe.ts. */
export const UNSUBSCRIBE_SUBJECT_PATTERN =
  /\bunsubscribe\s+(del_[0-9a-f]{16}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/i;

export type MailHeader = { name: string; value: string };

/** A Trevra canonical `message` record from the designated inbound mailbox. */
export type InboundEmailRecord = {
  id: string;
  kind: 'message';
  direction: 'inbound';
  mailboxAddress: string;
  personEmail: string;
  personName?: string;
  subject: string;
  body: string;
  occurredAt: string;
  externalUrl?: string;
  internetMessageId?: string;
  replyToMessageIds: string[];
  autoSubmitted: string | null;
};

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(address) ? address : null;
}

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function nodeCharset(charset: string): 'utf8' | 'latin1' | null {
  const name = (charset.toLowerCase().split('*')[0] ?? '').trim();
  if (name === 'utf-8' || name === 'utf8') return 'utf8';
  if (name === 'iso-8859-1' || name === 'latin1' || name === 'us-ascii' || name === 'ascii') {
    return 'latin1';
  }
  return null;
}

/** RFC 2047 encoded words in UTF-8, Latin-1 or ASCII; other charsets stay as sent. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1')
    .replace(ENCODED_WORD, (word: string, charset: string, encoding: string, text: string) => {
      const target = nodeCharset(charset);
      if (!target) return word;
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_match: string, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16))
                ),
              'latin1'
            );
      return bytes.toString(target);
    });
}

export function parseAddress(header: string | null): {
  address: string | null;
  name: string | null;
} {
  if (!header) return { address: null, name: null };
  const decoded = decodeMimeWords(header).trim();
  const angle = /<([^<>\s]+)>\s*$/.exec(decoded);
  const address = normalizeAddress(angle ? angle[1] : decoded);
  const name = angle
    ? decoded
        .slice(0, angle.index)
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
    : '';
  return { address, name: name ? name.slice(0, 200) : null };
}

export function parseMessageIds(value: string | null): string[] {
  return value ? (value.match(/<[^<>\s]+>/g) ?? []) : [];
}

/** In-Reply-To first, then References newest-first, de-duplicated and capped. */
export function replyToMessageIds(inReplyTo: string | null, references: string | null): string[] {
  const ids: string[] = [];
  for (const id of [...parseMessageIds(inReplyTo), ...parseMessageIds(references).reverse()]) {
    const bounded = id.slice(0, 998);
    if (!ids.includes(bounded)) ids.push(bounded);
    if (ids.length === MAX_REPLY_TO_IDS) break;
  }
  return ids;
}

export function headerValue(headers: readonly MailHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  const found = headers.find((candidate) => candidate.name.toLowerCase() === wanted);
  return found ? found.value : null;
}

/**
 * Mailing-list and bulk mail is not a conversation. A mailto unsubscribe that
 * carries a Trevra token always passes, whatever headers the client added.
 */
export function isBulkMail(headers: readonly MailHeader[], subject: string): boolean {
  if (UNSUBSCRIBE_SUBJECT_PATTERN.test(subject)) return false;
  if (headerValue(headers, 'List-Id') !== null) return true;
  if (headerValue(headers, 'List-Unsubscribe') !== null) return true;
  const precedence = (headerValue(headers, 'Precedence') ?? '').trim().toLowerCase();
  return precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
}

/** Gmail part bodies are base64url; honour the part's Content-Type charset (latin1 family, else utf8). */
export function decodePartData(data: string, headers: readonly MailHeader[] = []): string {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(
    headerValue(headers, 'Content-Type') ?? ''
  )?.[1];
  const latin1 = charset ? /^(iso-8859-1|latin1|windows-1252)$/i.test(charset) : false;
  return Buffer.from(data, 'base64url').toString(latin1 ? 'latin1' : 'utf8');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One provider message as a canonical record, or null when it is not a
 * person-to-person message to this mailbox. Trevra still re-checks everything
 * server-side (decideInboundMailboxRecord); this only avoids shipping noise.
 */
export function buildInboundRecord(input: {
  id: string;
  mailboxAddress: string;
  from: string | null;
  subject: string | null;
  body: string;
  occurredAt: string | number | null;
  externalUrl: string | null;
  internetMessageId: string | null;
  headers: readonly MailHeader[];
}): InboundEmailRecord | null {
  const mailbox = normalizeAddress(input.mailboxAddress);
  if (!mailbox) return null;
  const sender = parseAddress(input.from);
  if (!sender.address || sender.address === mailbox) return null;
  const subject = decodeMimeWords(input.subject ?? '')
    .trim()
    .slice(0, 998);
  if (isBulkMail(input.headers, subject)) return null;
  const occurred = input.occurredAt === null ? Number.NaN : new Date(input.occurredAt).getTime();
  if (!Number.isFinite(occurred)) return null;
  const messageId = parseMessageIds(input.internetMessageId)[0];
  const autoSubmitted = headerValue(input.headers, 'Auto-Submitted');
  return {
    id: input.id,
    kind: 'message',
    direction: 'inbound',
    mailboxAddress: mailbox,
    personEmail: sender.address,
    ...(sender.name ? { personName: sender.name } : {}),
    subject,
    body: input.body.slice(0, MAX_BODY_CHARS),
    occurredAt: new Date(occurred).toISOString(),
    ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
    ...(messageId ? { internetMessageId: messageId.slice(0, 998) } : {}),
    replyToMessageIds: replyToMessageIds(
      headerValue(input.headers, 'In-Reply-To'),
      headerValue(input.headers, 'References')
    ),
    autoSubmitted: autoSubmitted ? autoSubmitted.trim().slice(0, 200) : null
  };
}
