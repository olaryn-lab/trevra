/**
 * Pure helpers for the trevra-zoho-mail inbound-messages sync. Nango compiles
 * this folder on its own and cannot import src/server, so pickZohoAccount,
 * pickZohoFolderId and parseZohoHeaders are copies of
 * src/server/email/zoho-mail.ts; src/server/email/zoho-sync-helpers.test.ts
 * holds the copies identical.
 */
import { headerValue, htmlToText, type MailHeader } from './inbound-email.js';

export const ZOHO_LIST_PAGE_SIZE = 100;
/** Inbox entries listed per run before the oldest-first read. */
export const ZOHO_LIST_CEILING = 1000;
/**
 * Each message costs up to two API calls (original message, then header
 * fallback). Sized against Zoho's API limits in the plan's smoke step S8.
 */
export const ZOHO_MAX_MESSAGES_PER_RUN = 100;
/** The messages/view `sortorder` value that lists newest first (smoke step S5). */
export const ZOHO_LIST_NEWEST_FIRST = 'false';
const MIME_MAX_DEPTH = 5;

export type ZohoAccount = { accountId: string; address: string };
export type ZohoListEntry = {
  messageId: string;
  receivedMs: number;
  fromAddress: string | null;
  subject: string | null;
  summary: string;
};

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function dataOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'data' in body
    ? (body as { data?: unknown }).data
    : undefined;
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** The one ZOHO_ACCOUNT the token can read, or null when there is not exactly one. */
export function pickZohoAccount(body: unknown): ZohoAccount | null {
  const list = dataOf(body);
  if (!Array.isArray(list)) return null;
  const accounts = list.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'ZOHO_ACCOUNT'
  );
  if (accounts.length !== 1) return null;
  const account = accounts[0]!;
  const accountId = idText(account['accountId']);
  const raw = account['primaryEmailAddress'] ?? account['mailboxAddress'];
  const address = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!accountId || !ADDRESS.test(address)) return null;
  return { accountId, address };
}

/** The id of the account's Inbox or Sent folder; folderType wins over folderName. */
export function pickZohoFolderId(body: unknown, kind: 'inbox' | 'sent'): string | null {
  const list = dataOf(body);
  if (!Array.isArray(list)) return null;
  const folders = list.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
  );
  const named = (field: 'folderType' | 'folderName') =>
    folders.find(
      (folder) =>
        String(folder[field] ?? '')
          .trim()
          .toLowerCase() === kind
    );
  return idText((named('folderType') ?? named('folderName'))?.['folderId']);
}

function headerBlock(block: string): MailHeader[] {
  const headers: MailHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

/** Zoho's header endpoint: a raw block, { headerContent: block }, or a name-to-value map. */
export function parseZohoHeaders(body: unknown): MailHeader[] {
  const data = dataOf(body);
  if (typeof data === 'string') return headerBlock(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const content = (data as { headerContent?: unknown }).headerContent;
  if (typeof content === 'string') return headerBlock(content);
  const map = content && typeof content === 'object' && !Array.isArray(content) ? content : data;
  const headers: MailHeader[] = [];
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') headers.push({ name, value: item.trim() });
    }
  }
  return headers;
}

/** messages/view entries that carry an id and a received time (epoch ms). */
export function zohoListEntries(body: unknown): ZohoListEntry[] {
  const list = dataOf(body);
  if (!Array.isArray(list)) return [];
  const entries: ZohoListEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const messageId = idText(entry['messageId']);
    const receivedMs = Number(entry['receivedTime']);
    if (!messageId || !Number.isFinite(receivedMs) || receivedMs <= 0) continue;
    entries.push({
      messageId,
      receivedMs,
      fromAddress:
        typeof entry['fromAddress'] === 'string' && entry['fromAddress'].trim()
          ? entry['fromAddress'].trim()
          : null,
      subject: typeof entry['subject'] === 'string' ? entry['subject'] : null,
      summary: typeof entry['summary'] === 'string' ? entry['summary'].trim() : ''
    });
  }
  return entries;
}

/** The raw RFC 5322 message from originalmessage: a string body, data, or data.content. */
export function mimeFromOriginalMessage(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() ? body : null;
  const data = dataOf(body);
  if (typeof data === 'string') return data.trim() ? data : null;
  const content =
    data && typeof data === 'object' ? (data as { content?: unknown }).content : undefined;
  return typeof content === 'string' && content.trim() ? content : null;
}

function splitEntity(entity: string): { headers: MailHeader[]; body: string } {
  const text = entity.replace(/\r\n/g, '\n');
  if (text.startsWith('\n')) return { headers: [], body: text.slice(1) };
  const gap = text.indexOf('\n\n');
  return gap === -1
    ? { headers: headerBlock(text), body: '' }
    : { headers: headerBlock(text.slice(0, gap)), body: text.slice(gap + 2) };
}

function quotedPrintableBytes(text: string): Buffer {
  const joined = text.replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const hex = joined.slice(index + 1, index + 3);
    if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(joined[index]!, 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

/** Undo the part's transfer encoding; honour a latin1-family charset, else utf8. */
function decodeBody(body: string, headers: readonly MailHeader[]): string {
  const encoding = (headerValue(headers, 'Content-Transfer-Encoding') ?? '').trim().toLowerCase();
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(
    headerValue(headers, 'Content-Type') ?? ''
  )?.[1];
  const latin1 = charset ? /^(iso-8859-1|latin1|windows-1252)$/i.test(charset) : false;
  if (encoding === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(latin1 ? 'latin1' : 'utf8');
  }
  if (encoding === 'quoted-printable') {
    return quotedPrintableBytes(body).toString(latin1 ? 'latin1' : 'utf8');
  }
  return body;
}

function findPart(
  entity: string,
  mimeType: 'text/plain' | 'text/html',
  depth: number
): string | null {
  const { headers, body } = splitEntity(entity);
  const contentType = headerValue(headers, 'Content-Type') ?? 'text/plain';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    if (depth >= MIME_MAX_DEPTH) return null;
    const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim();
    if (!boundary) return null;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      const found = findPart(part.replace(/^[ \t]*\n/, ''), mimeType, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (/^\s*attachment/i.test(headerValue(headers, 'Content-Disposition') ?? '')) return null;
  return type === mimeType ? decodeBody(body, headers) : null;
}

/** Top-level headers plus the first inline text/plain part, else the first HTML part as text. */
export function parseMimeMessage(raw: string): { headers: MailHeader[]; text: string } {
  const { headers } = splitEntity(raw);
  const plain = findPart(raw, 'text/plain', 0);
  if (plain !== null) return { headers, text: plain.trim() };
  const html = findPart(raw, 'text/html', 0);
  return { headers, text: html !== null ? htmlToText(html) : '' };
}
