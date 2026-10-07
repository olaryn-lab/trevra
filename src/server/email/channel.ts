import { z } from 'zod';
import type { Db } from '../db.js';
import { getNango } from '../integration-service.js';
import { emailDomainOf, type DnsResolver } from './deliverability.js';
import { INBOUND_SYNC_FAILED_ERROR, INBOUND_SYNC_NAME } from './inbound-mailbox.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { getSenderDeliverability } from './sender-deliverability.js';
import { unsubscribeConfigured } from './unsubscribe.js';
import type {
  EmailChannelStatus,
  EmailInboundMailboxState,
  InboundSyncStatus,
  StoredDeliverability
} from './types.js';

export { INBOUND_SYNC_NAME } from './inbound-mailbox.js';

/** How long GET waits for Nango's sync status before reporting the stored state. */
export const NANGO_SYNC_STATUS_DEADLINE_MS = 5_000;

/** Connection metadata the sync verifies the provider profile against. */
export const INBOUND_ADDRESS_METADATA_KEY = 'trevraInboundAddress';

/** Nango's sync error state (SyncStatus in @nangohq/types). */
const NANGO_SYNC_ERROR = 'ERROR';

const designatedAddressSchema = z.string().trim().toLowerCase().email();

export class EmailChannelError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'EmailChannelError';
  }
}

export interface EmailChannelOptions {
  resolver?: DnsResolver;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Overrides the per-lookup deadlines (tests use a short one). */
  deadlineMs?: number;
}

interface InboundRow {
  connection_id: string;
  address: string;
  sync_status: InboundSyncStatus;
  sync_error: string | null;
  designated_at: string;
  last_record_at: string | null;
  provider_config_key: string;
  external_connection_id: string;
}

async function readInbound(db: Db, workspaceId: string): Promise<InboundRow | undefined> {
  return db
    .prepare(
      `SELECT m.connection_id,m.address,m.sync_status,m.sync_error,m.designated_at,m.last_record_at,
              c.provider_config_key,c.external_connection_id
       FROM email_inbound_mailboxes m
       JOIN connections c ON c.workspace_id=m.workspace_id AND c.id=m.connection_id
       WHERE m.workspace_id=?`
    )
    .get<InboundRow>(workspaceId);
}

/** Serializes designate/clear per workspace for the life of the transaction. */
async function lockInbound(tx: Db, workspaceId: string): Promise<void> {
  await tx
    .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
    .get(`email_inbound_mailbox:${workspaceId}`);
}

async function nangoSyncState(
  row: InboundRow,
  deadlineMs: number
): Promise<EmailInboundMailboxState['nango']> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The Nango SDK's HTTP client has no timeout of its own.
    const response = await Promise.race([
      getNango().syncStatus(
        row.provider_config_key,
        [INBOUND_SYNC_NAME],
        row.external_connection_id
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadlineMs));
        timer.unref();
      })
    ]);
    if (!response) return null;
    const sync = response.syncs[0];
    return sync ? { status: sync.status, finishedAt: sync.finishedAt ?? null } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pauseInboundSync(
  row: Pick<InboundRow, 'provider_config_key' | 'external_connection_id'>
): Promise<void> {
  try {
    await getNango().pauseSync(
      row.provider_config_key,
      [INBOUND_SYNC_NAME],
      row.external_connection_id
    );
  } catch (error) {
    // Best effort: the ingest path also ignores records from a mailbox that is
    // no longer designated, so a sync that keeps running stores nothing.
    console.error(
      'Could not pause the inbound mailbox sync',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function isoOrNull(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function getEmailChannelStatus(
  db: Db,
  workspaceId: string,
  options: EmailChannelOptions = {}
): Promise<EmailChannelStatus> {
  const env = options.env ?? process.env;
  const mailboxes = await listSendingMailboxes(db, workspaceId);
  // In parallel: each lookup is bounded by its own deadline, so the whole
  // request waits for the slowest mailbox, not the sum of all of them.
  const rows: EmailChannelStatus['mailboxes'] = await Promise.all(
    mailboxes.map(async (mailbox) => {
      const address = await resolveMailboxAddress(db, workspaceId, mailbox, {
        deadlineMs: options.deadlineMs
      });
      const domain = address ? emailDomainOf(address) : null;
      const deliverability: StoredDeliverability | null = domain
        ? await getSenderDeliverability(
            db,
            workspaceId,
            { domain, provider: mailbox.providerKey },
            { resolver: options.resolver, now: options.now, deadlineMs: options.deadlineMs }
          )
        : null;
      // Deliberately field by field: provider config keys and Nango connection
      // ids never reach the browser.
      return {
        connectionId: mailbox.connectionId,
        provider: mailbox.provider,
        providerKey: mailbox.providerKey,
        displayName: mailbox.displayName,
        address,
        deliverability
      };
    })
  );
  const row = await readInbound(db, workspaceId);
  let inbound: EmailInboundMailboxState | null = null;
  if (row) {
    const nango =
      row.sync_status === 'unavailable'
        ? null
        : await nangoSyncState(row, options.deadlineMs ?? NANGO_SYNC_STATUS_DEADLINE_MS);
    let syncStatus = row.sync_status;
    let syncError = row.sync_error;
    if (
      nango?.status === NANGO_SYNC_ERROR &&
      syncStatus !== 'unavailable' &&
      nango.finishedAt &&
      Date.parse(nango.finishedAt) > Date.parse(row.designated_at)
    ) {
      // Nango says the sync failed after this designation: stop claiming the
      // inbox is read. Fixed, content-free text; a later successful sync webhook
      // flips it back. Conditional, so a newer designation is never overwritten.
      const flipped = await db
        .prepare(
          `UPDATE email_inbound_mailboxes SET sync_status='unavailable',sync_error=?,updated_at=?::timestamptz
           WHERE workspace_id=? AND connection_id=? AND designated_at=?::timestamptz AND sync_status=?`
        )
        .run(
          INBOUND_SYNC_FAILED_ERROR,
          new Date().toISOString(),
          workspaceId,
          row.connection_id,
          row.designated_at,
          row.sync_status
        );
      if (flipped.changes > 0) {
        syncStatus = 'unavailable';
        syncError = INBOUND_SYNC_FAILED_ERROR;
      }
    }
    inbound = {
      connectionId: row.connection_id,
      address: row.address,
      syncStatus,
      syncError,
      designatedAt: new Date(row.designated_at).toISOString(),
      lastRecordAt: isoOrNull(row.last_record_at),
      nango
    };
  }
  const oneClick = unsubscribeConfigured(env);
  const mailto =
    oneClick &&
    inbound?.syncStatus === 'syncing' &&
    mailboxes.some((mailbox) => mailbox.connectionId === inbound.connectionId);
  return {
    unsubscribe: {
      oneClick,
      mailto,
      detail: !oneClick
        ? 'One-click unsubscribe needs an HTTPS TREVRA_PUBLIC_API_URL and TREVRA_SECRETS_KEY on the server. Email outreach stays blocked until both are set.'
        : mailto
          ? `Every outreach email offers one-click unsubscribe and mailto:${inbound!.address}.`
          : 'Every outreach email offers one-click unsubscribe.'
    },
    mailboxes: rows,
    inbound
  };
}

/**
 * Make one connected mailbox the workspace's inbound mailbox. The address comes
 * from the provider and is written into Nango connection metadata; the sync
 * refuses to emit anything if the mailbox's profile no longer matches it.
 */
export async function designateInboundMailbox(
  db: Db,
  input: { workspaceId: string; connectionId: string; actorUserId: string },
  now: Date = new Date()
): Promise<InboundSyncStatus> {
  const mailbox = (await listSendingMailboxes(db, input.workspaceId)).find(
    (candidate) => candidate.connectionId === input.connectionId
  );
  if (!mailbox) {
    throw new EmailChannelError(
      'Connect this Gmail or Microsoft 365 mailbox before using it for inbound mail.',
      404
    );
  }
  const resolved = await resolveMailboxAddress(db, input.workspaceId, mailbox);
  // The address is stored, written into Nango metadata and shown in a mailto:,
  // so it must be one plain address: no CR/LF, no `>`, no `,`.
  const parsed = resolved ? designatedAddressSchema.safeParse(resolved) : null;
  if (!parsed?.success) {
    throw new EmailChannelError(
      'Trevra could not read this mailbox address from the provider. Reconnect the mailbox and try again.',
      409
    );
  }
  const address = parsed.data;
  const at = now.toISOString();
  const previous = await db.transaction(async (tx) => {
    await lockInbound(tx, input.workspaceId);
    const before = await readInbound(tx, input.workspaceId);
    await tx
      .prepare(
        `INSERT INTO email_inbound_mailboxes
           (workspace_id,connection_id,address,sync_status,sync_error,designated_by_user_id,designated_at,last_record_at,updated_at)
         VALUES (?,?,?,'starting',NULL,?,?::timestamptz,NULL,?::timestamptz)
         ON CONFLICT (workspace_id) DO UPDATE SET
           connection_id=excluded.connection_id,address=excluded.address,sync_status='starting',sync_error=NULL,
           designated_by_user_id=excluded.designated_by_user_id,designated_at=excluded.designated_at,
           last_record_at=CASE
             WHEN email_inbound_mailboxes.connection_id=excluded.connection_id
              AND email_inbound_mailboxes.address=excluded.address
             THEN email_inbound_mailboxes.last_record_at ELSE NULL END,
           updated_at=excluded.updated_at`
      )
      .run(input.workspaceId, mailbox.connectionId, address, input.actorUserId, at, at);
    return before;
  });
  // Outside the transaction: a slow Nango call must not hold the lock.
  if (previous && previous.connection_id !== mailbox.connectionId) await pauseInboundSync(previous);

  let status: InboundSyncStatus = 'syncing';
  let syncError: string | null = null;
  try {
    const nango = getNango();
    await nango.updateMetadata(mailbox.providerConfigKey, mailbox.externalConnectionId, {
      [INBOUND_ADDRESS_METADATA_KEY]: address
    });
    await nango.startSync(
      mailbox.providerConfigKey,
      [INBOUND_SYNC_NAME],
      mailbox.externalConnectionId
    );
  } catch (error) {
    // Free self-hosted Nango has no syncs, and a deployment may not have pushed
    // nango-integrations/ yet. Say so instead of claiming the inbox is read.
    status = 'unavailable';
    syncError =
      `Nango could not start the ${INBOUND_SYNC_NAME} sync: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        500
      );
  }
  const settled = await db
    .prepare(
      `UPDATE email_inbound_mailboxes SET sync_status=?,sync_error=?,updated_at=?::timestamptz
       WHERE workspace_id=? AND connection_id=? AND designated_at=?::timestamptz`
    )
    .run(status, syncError, new Date().toISOString(), input.workspaceId, mailbox.connectionId, at);
  if (settled.changes === 0) {
    // A concurrent DELETE or PUT replaced this designation while Nango was
    // starting the sync: do not leave it running for a mailbox nobody chose.
    await pauseInboundSync({
      provider_config_key: mailbox.providerConfigKey,
      external_connection_id: mailbox.externalConnectionId
    });
    const current = await readInbound(db, input.workspaceId);
    return current?.sync_status ?? 'unavailable';
  }
  return status;
}

export async function clearInboundMailbox(db: Db, workspaceId: string): Promise<boolean> {
  const { row, deleted } = await db.transaction(async (tx) => {
    await lockInbound(tx, workspaceId);
    const existing = await readInbound(tx, workspaceId);
    const result = await tx
      .prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=?')
      .run(workspaceId);
    return { row: existing, deleted: result };
  });
  if (row) await pauseInboundSync(row);
  return deleted.changes > 0;
}

/** Force a fresh DNS evaluation for every sending mailbox's domain. */
export async function recheckEmailDeliverability(
  db: Db,
  workspaceId: string,
  options: { resolver?: DnsResolver; now?: Date; deadlineMs?: number } = {}
): Promise<void> {
  const mailboxes = await listSendingMailboxes(db, workspaceId);
  await Promise.all(
    mailboxes.map(async (mailbox) => {
      const address = await resolveMailboxAddress(db, workspaceId, mailbox, {
        deadlineMs: options.deadlineMs
      });
      const domain = address ? emailDomainOf(address) : null;
      if (!domain) return;
      await getSenderDeliverability(
        db,
        workspaceId,
        { domain, provider: mailbox.providerKey, force: true },
        options
      );
    })
  );
}
