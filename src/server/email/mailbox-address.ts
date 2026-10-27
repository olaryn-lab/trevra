import { z } from 'zod/v3';
import type { Db } from '../db.js';
import { getNango } from '../integration-service.js';
import { mailProviderFor } from './deliverability.js';
import type { EmailChannelMailbox } from './types.js';
import { readZohoAccount } from './zoho-mail.js';

export interface SendingMailbox extends EmailChannelMailbox {
  providerConfigKey: string;
  externalConnectionId: string;
}

interface ConnectionRow {
  id: string;
  provider: string;
  provider_config_key: string;
  external_connection_id: string;
  display_name: string | null;
  mailbox_address: string | null;
}

const addressSchema = z.string().email();

/**
 * The longest a request (GET /api/email/channel, plan compile) waits for the
 * provider to name the mailbox. One proxied profile read is normally well under
 * a second; five seconds leaves room for a Nango retry. Past it the address is
 * unknown for this request and nothing is cached, so the next request asks again.
 */
export const MAILBOX_ADDRESS_DEADLINE_MS = 5_000;

/** Live (non-demo) connected Gmail / Microsoft 365 / Zoho Mail mailboxes, newest first. */
export async function listSendingMailboxes(db: Db, workspaceId: string): Promise<SendingMailbox[]> {
  const rows = await db
    .prepare(
      `SELECT id,provider,provider_config_key,external_connection_id,display_name,mailbox_address
       FROM connections
       WHERE workspace_id=? AND status='connected' AND is_demo=0
         AND provider IN ('gmail','google-mail','microsoft','outlook','zoho-mail')
       ORDER BY updated_at DESC,id ASC`
    )
    .all<ConnectionRow>(workspaceId);
  return rows.flatMap((row) => {
    const providerKey = mailProviderFor(row.provider);
    if (!providerKey) return [];
    return [
      {
        connectionId: row.id,
        provider: row.provider,
        providerKey,
        displayName: row.display_name,
        address: row.mailbox_address,
        providerConfigKey: row.provider_config_key,
        externalConnectionId: row.external_connection_id
      }
    ];
  });
}

async function readProviderAddress(mailbox: SendingMailbox): Promise<string> {
  const nango = getNango();
  if (mailbox.providerKey === 'zoho') {
    // Exactly one Zoho account, or no address: readZohoAccount throws on an
    // ambiguous list and resolveMailboxAddress then caches nothing.
    const account = await readZohoAccount(nango, {
      providerConfigKey: mailbox.providerConfigKey,
      connectionId: mailbox.externalConnectionId
    });
    return account.address;
  }
  if (mailbox.providerKey === 'google') {
    const profile = await nango.get<{ emailAddress?: string }>({
      endpoint: '/gmail/v1/users/me/profile',
      providerConfigKey: mailbox.providerConfigKey,
      connectionId: mailbox.externalConnectionId,
      retries: 3
    });
    return String(profile.data.emailAddress ?? '');
  }
  const me = await nango.get<{ mail?: string | null; userPrincipalName?: string | null }>({
    endpoint: '/v1.0/me',
    providerConfigKey: mailbox.providerConfigKey,
    connectionId: mailbox.externalConnectionId,
    retries: 3,
    params: { $select: 'mail,userPrincipalName' }
  });
  return String(me.data.mail || me.data.userPrincipalName || '');
}

/**
 * The address this mailbox actually sends as, read from the provider (Gmail
 * users/me/profile, Graph /me, Zoho /api/accounts) and cached on the connection. The auth webhook's
 * end_user_email tag is the Trevra user, not the mailbox, so it is never used.
 * Returns null when the provider cannot be asked, answers with no address, or
 * does not answer within `deadlineMs`.
 *
 * The cache is read from the row, never from the caller's snapshot, and written
 * only if the row is unchanged since that read: a re-authorization in between
 * (which clears mailbox_address and bumps updated_at) means the answer may
 * belong to the previous account, so it is discarded.
 */
export async function resolveMailboxAddress(
  db: Db,
  workspaceId: string,
  mailbox: SendingMailbox,
  options: { deadlineMs?: number } = {}
): Promise<string | null> {
  const current = await db
    .prepare(
      'SELECT mailbox_address,updated_at::text AS version FROM connections WHERE id=? AND workspace_id=?'
    )
    .get<{ mailbox_address: string | null; version: string }>(mailbox.connectionId, workspaceId);
  if (!current) return null;
  if (current.mailbox_address) return current.mailbox_address;
  const deadlineMs = options.deadlineMs ?? MAILBOX_ADDRESS_DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  let raw: string | null;
  try {
    raw = await Promise.race([
      readProviderAddress(mailbox),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadlineMs));
        timer.unref();
      })
    ]);
  } catch (error) {
    console.error(
      'Could not read the mailbox address from the provider',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (raw === null) {
    console.error(`The mail provider did not name the mailbox within ${deadlineMs}ms`);
    return null;
  }
  const parsed = addressSchema.safeParse(raw.trim().toLowerCase());
  if (!parsed.success) return null;
  // An identity cache, not a user-visible change: updated_at stays put so the
  // connection's place in "newest mailbox first" ordering does not move.
  const cached = await db
    .prepare(
      `UPDATE connections SET mailbox_address=?
       WHERE id=? AND workspace_id=? AND mailbox_address IS NULL AND updated_at=?::timestamptz`
    )
    .run(parsed.data, mailbox.connectionId, workspaceId, current.version);
  if (cached.changes === 1) return parsed.data;
  // Lost to a concurrent resolve of the same, unchanged connection: use its answer.
  const winner = await db
    .prepare(
      'SELECT mailbox_address FROM connections WHERE id=? AND workspace_id=? AND updated_at=?::timestamptz'
    )
    .get<{ mailbox_address: string | null }>(mailbox.connectionId, workspaceId, current.version);
  return winner?.mailbox_address ?? null;
}
