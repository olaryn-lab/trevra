import type { Nango } from '@nangohq/node';

/*
 * Zoho Mail through Nango's built-in `zoho-mail` provider (OAuth2; the
 * connection's `extension` picks the data centre: mail.zoho.<extension>).
 * Nango holds the token. The Zoho accountId is re-read per send and never
 * stored. Must not import integration-service.ts, which imports this module;
 * callers pass their Nango client.
 *
 * Response shapes are the ones recorded by the Phase G smoke test
 * (.superpowers/sdd/2026-10-07-gtm-g-zoho-mail/smoke-results.md).
 * nango-integrations/shared/zoho-mail.ts carries a copy of the pure parsers for
 * the sync; src/server/email/zoho-sync-helpers.test.ts keeps them equal.
 */

export const ZOHO_MAIL_PROVIDER = 'zoho-mail';

/**
 * Outreach emails one Zoho mailbox may send in a rolling 24 hours. Zoho
 * treats roughly 5,000 a day as bulk, so this stays at about 1% of that. The
 * operator's per-mailbox daily_limit can lower it, never raise it.
 */
export const ZOHO_OUTREACH_DAILY_CAP = 50;

/** Upper bound on the post-send Message-ID read; the send has already happened. */
export const ZOHO_MESSAGE_ID_READ_TIMEOUT_MS = 5_000;

export type ZohoNango = Pick<Nango, 'get' | 'post'>;
export interface ZohoConnection {
  providerConfigKey: string;
  connectionId: string;
}
export interface ZohoAccount {
  accountId: string;
  address: string;
}
export type ZohoHeader = { name: string; value: string };

export class ZohoMailError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

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

/** The one ZOHO_ACCOUNT the token can send from, or null when there is not exactly one. */
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
  const accountId = idText(account.accountId);
  const raw = account.primaryEmailAddress ?? account.mailboxAddress;
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
  return idText((named('folderType') ?? named('folderName'))?.folderId);
}

function headerBlock(block: string): ZohoHeader[] {
  const headers: ZohoHeader[] = [];
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
export function parseZohoHeaders(body: unknown): ZohoHeader[] {
  const data = dataOf(body);
  if (typeof data === 'string') return headerBlock(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const content = (data as { headerContent?: unknown }).headerContent;
  if (typeof content === 'string') return headerBlock(content);
  const map = content && typeof content === 'object' && !Array.isArray(content) ? content : data;
  const headers: ZohoHeader[] = [];
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') headers.push({ name, value: item.trim() });
    }
  }
  return headers;
}

export function zohoHeaderValue(headers: readonly ZohoHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === wanted)?.value ?? null;
}

/** The RFC 5322 msg-id, bounded exactly as the inbound sync bounds In-Reply-To ids. */
// lc-debt: duplicates normalizedMessageId in integration-service.ts; upgrade path is moving it to a shared pure module.
export function zohoMessageId(headers: readonly ZohoHeader[]): string | null {
  const match = /<[^<>\s]+>/.exec(zohoHeaderValue(headers, 'Message-ID') ?? '');
  return match ? match[0].slice(0, 998) : null;
}

function accountPath(accountId: string): string {
  return `/api/accounts/${encodeURIComponent(accountId)}`;
}

/** The account this connection sends from. Exactly one, or ZohoMailError. */
export async function readZohoAccount(
  nango: ZohoNango,
  connection: ZohoConnection
): Promise<ZohoAccount> {
  const response = await nango.get<unknown>({
    endpoint: '/api/accounts',
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.connectionId,
    retries: 3
  });
  const account = pickZohoAccount(response.data);
  if (!account) {
    throw new ZohoMailError(
      'This Zoho Mail connection does not resolve to exactly one Zoho mail account, so Trevra cannot tell which address it sends as. Reconnect the mailbox you send outreach from.'
    );
  }
  return account;
}

/**
 * One plain-text send. retries: 0, because Zoho's send API takes no
 * idempotency key; the gtm_deliveries claim is the only dedupe, and a send
 * that fails without a 4xx is recorded as uncertain and never resent.
 */
export async function sendZohoMessage(
  nango: ZohoNango,
  connection: ZohoConnection,
  input: {
    accountId: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
    content: string;
  }
): Promise<{ messageId: string | null }> {
  const response = await nango.post<unknown>({
    endpoint: `${accountPath(input.accountId)}/messages`,
    providerConfigKey: connection.providerConfigKey,
    connectionId: connection.connectionId,
    retries: 0,
    data: {
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      subject: input.subject,
      content: input.content,
      mailFormat: 'plaintext',
      encoding: 'UTF-8'
    }
  });
  const data = dataOf(response.data);
  const messageId =
    data && typeof data === 'object' ? idText((data as { messageId?: unknown }).messageId) : null;
  return { messageId };
}

/**
 * The Message-ID Zoho actually sent, so a reply's In-Reply-To threads to it.
 * Any failure, a missing Sent folder, or the timeout returns null; the email
 * has already left, so this must never fail or retry the send.
 *
 * lc-debt: a timed-out read is abandoned, not aborted (the Nango SDK proxy takes no AbortSignal); upgrade path is passing an AbortSignal once the SDK accepts one.
 */
export async function readZohoSentMessageId(
  nango: ZohoNango,
  connection: ZohoConnection,
  input: { accountId: string; messageId: string },
  timeoutMs: number = ZOHO_MESSAGE_ID_READ_TIMEOUT_MS
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const read = (async () => {
      const folders = await nango.get<unknown>({
        endpoint: `${accountPath(input.accountId)}/folders`,
        providerConfigKey: connection.providerConfigKey,
        connectionId: connection.connectionId,
        retries: 0
      });
      const sentFolderId = pickZohoFolderId(folders.data, 'sent');
      if (!sentFolderId) return null;
      const header = await nango.get<unknown>({
        endpoint: `${accountPath(input.accountId)}/folders/${encodeURIComponent(sentFolderId)}/messages/${encodeURIComponent(input.messageId)}/header`,
        providerConfigKey: connection.providerConfigKey,
        connectionId: connection.connectionId,
        retries: 0
      });
      return zohoMessageId(parseZohoHeaders(header.data));
    })().catch(() => null);
    return await Promise.race([read, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
