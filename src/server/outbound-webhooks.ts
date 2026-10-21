/**
 * Merchant-controlled outbound event notifications. Nothing in this module
 * performs provider writes at event creation time: the domain transaction
 * appends one minimal payload per matching subscription to a durable outbox.
 * Dispatcher is an explicit operator/worker action with a static host allowlist.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { id, type Db } from './db.js';
import { openSecret, sealSecret, type SecretContext } from './secrets/crypto.js';
import type { DomainEvent } from './control-plane/events.js';

export const OUTBOUND_WEBHOOK_EVENTS = [
  'linkedin_campaign.started',
  'linkedin_campaign.stopped',
  'linkedin_campaign.paused',
  'playbook.run.completed',
  'playbook.run.failed'
] as const;
export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];
const allowedEvents = new Set<string>(OUTBOUND_WEBHOOK_EVENTS);
export class OutboundWebhookInputError extends Error {
  readonly status = 400;
}
const MAX_ATTEMPTS = 6;
const SIGNATURE_VERSION = 'v1';

function secretContext(workspaceId: string, subscriptionId: string): SecretContext {
  return {
    store: 'outbound_webhook_subscriptions',
    workspaceId,
    seatKey: 'owner',
    kind: `outbound:${subscriptionId}`
  };
}

export function allowedWebhookHostnames(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      (env.TREVRA_OUTBOUND_WEBHOOK_HOSTS ?? '')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

export function validateWebhookTarget(raw: string, allowedHosts: readonly string[]): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new OutboundWebhookInputError('Webhook endpoint must be a valid HTTPS URL.');
  }
  if (
    value.protocol !== 'https:' ||
    !value.hostname ||
    value.port ||
    value.username ||
    value.password ||
    value.hash ||
    value.search ||
    isIP(value.hostname) ||
    !allowedHosts.includes(value.hostname.toLowerCase())
  ) {
    throw new OutboundWebhookInputError(
      'Webhook endpoint must be HTTPS on an explicitly allowed host, without IP, credentials, query or fragment.'
    );
  }
  if (value.toString().length > 1500)
    throw new OutboundWebhookInputError('Webhook URL exceeds size limit.');
  return value.toString();
}

export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
}
interface SubscriptionRow {
  id: string;
  workspace_id: string;
  url: string;
  event_types: string[];
  active: boolean;
  created_at: string;
}
function serializeSubscription(row: SubscriptionRow): WebhookSubscription {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    url: row.url,
    eventTypes: row.event_types,
    active: row.active,
    createdAt: String(row.created_at)
  };
}

export async function createOutboundWebhookSubscription(
  db: Db,
  input: {
    workspaceId: string;
    url: string;
    eventTypes: readonly string[];
    actorId?: string | null;
  },
  allowedHosts: readonly string[] = allowedWebhookHostnames()
): Promise<{ subscription: WebhookSubscription; signingSecret: string }> {
  const url = validateWebhookTarget(input.url, allowedHosts);
  const eventTypes = [...new Set(input.eventTypes)];
  if (
    !eventTypes.length ||
    eventTypes.length > OUTBOUND_WEBHOOK_EVENTS.length ||
    eventTypes.some((item) => !allowedEvents.has(item))
  )
    throw new OutboundWebhookInputError(
      'Webhook event types must be a nonempty list of supported lifecycle events.'
    );
  const subscriptionId = id('owhs');
  const signingSecret = `whsec_${randomBytes(32).toString('hex')}`;
  const sealed = sealSecret(signingSecret, secretContext(input.workspaceId, subscriptionId));
  const row = await db
    .prepare(
      `INSERT INTO outbound_webhook_subscriptions
    (id,workspace_id,url,event_types,ciphertext,iv,auth_tag,key_version,key_id,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id,workspace_id,url,event_types,active,created_at`
    )
    .get<SubscriptionRow>(
      subscriptionId,
      input.workspaceId,
      url,
      eventTypes,
      sealed.ciphertext,
      sealed.iv,
      sealed.authTag,
      sealed.keyVersion,
      sealed.keyId,
      input.actorId ?? null
    );
  if (!row) throw new Error('Could not persist webhook subscription.');
  return { subscription: serializeSubscription(row), signingSecret };
}

export async function listOutboundWebhookSubscriptions(
  db: Db,
  workspaceId: string
): Promise<WebhookSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT id,workspace_id,url,event_types,active,created_at
    FROM outbound_webhook_subscriptions WHERE workspace_id=? ORDER BY created_at,id`
    )
    .all<SubscriptionRow>(workspaceId);
  return rows.map(serializeSubscription);
}

export interface OutboundWebhookDeliverySummary {
  id: string;
  eventId: string;
  status: 'pending' | 'leased' | 'delivered' | 'dead';
  attempts: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
}

export async function listOutboundWebhookDeliveries(
  db: Db,
  workspaceId: string,
  subscriptionId: string,
  limit = 100
): Promise<OutboundWebhookDeliverySummary[] | null> {
  const subscription = await db
    .prepare(
      `SELECT id FROM outbound_webhook_subscriptions
    WHERE workspace_id=? AND id=?`
    )
    .get<{ id: string }>(workspaceId, subscriptionId);
  if (!subscription) return null;
  const rows = await db
    .prepare(
      `SELECT id,event_id,status,attempts,last_http_status,last_error,
      TO_CHAR(delivered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS delivered_at
    FROM outbound_webhook_deliveries WHERE workspace_id=? AND subscription_id=?
    ORDER BY created_at DESC,id LIMIT ?`
    )
    .all<{
      id: string;
      event_id: string;
      status: OutboundWebhookDeliverySummary['status'];
      attempts: number;
      last_http_status: number | null;
      last_error: string | null;
      delivered_at: string | null;
    }>(workspaceId, subscriptionId, Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    attempts: Number(row.attempts),
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    deliveredAt: row.delivered_at
  }));
}

export async function deactivateOutboundWebhookSubscription(
  db: Db,
  workspaceId: string,
  subscriptionId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx
      .prepare(
        `UPDATE outbound_webhook_subscriptions
      SET active=FALSE,updated_at=NOW() WHERE workspace_id=? AND id=? AND active=TRUE`
      )
      .run(workspaceId, subscriptionId);
    await tx
      .prepare(
        `UPDATE outbound_webhook_deliveries SET status='dead',lease_token=NULL,
      leased_until=NULL,last_error='Subscription deactivated',updated_at=NOW()
      WHERE workspace_id=? AND subscription_id=? AND status IN ('pending','leased')`
      )
      .run(workspaceId, subscriptionId);
    return result.changes > 0;
  });
}

/** Minimal event envelope: never emit a domain event's unrestricted payload or metadata. */
export function webhookEventEnvelope(event: DomainEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.eventType,
    occurredAt: event.occurredAt,
    data: {
      streamType: event.streamType,
      streamId: event.streamId,
      streamVersion: event.streamVersion
    }
  };
}

/** Must be invoked inside the SAME database transaction as appendDomainEvent. */
export async function enqueueOutboundWebhookEvent(db: Db, event: DomainEvent): Promise<number> {
  if (!allowedEvents.has(event.eventType)) return 0;
  const result = await db
    .prepare(
      `INSERT INTO outbound_webhook_deliveries
    (id,workspace_id,subscription_id,event_id,payload_json)
    SELECT 'owhd_' || md5(s.id || ':' || ?),s.workspace_id,s.id,?,?::jsonb
    FROM outbound_webhook_subscriptions s
    WHERE s.workspace_id=? AND s.active=TRUE AND ?=ANY(s.event_types)
    ON CONFLICT (subscription_id,event_id) DO NOTHING`
    )
    .run(
      event.id,
      event.id,
      JSON.stringify(webhookEventEnvelope(event)),
      event.workspaceId,
      event.eventType
    );
  return result.changes;
}

interface DeliveryRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  event_id: string;
  payload_json: unknown;
  url: string;
  active: boolean;
  attempts: number;
  lease_token: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  key_id: string | null;
}
export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  const hash = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},${SIGNATURE_VERSION}=${hash}`;
}

async function claimDeliveries(db: Db, limit: number, now: Date): Promise<DeliveryRow[]> {
  return db.transaction(async (tx) => {
    const ids = await tx
      .prepare(
        `SELECT d.id FROM outbound_webhook_deliveries d
      JOIN outbound_webhook_subscriptions s ON s.id=d.subscription_id AND s.workspace_id=d.workspace_id
      WHERE s.active=TRUE AND ((d.status='pending' AND d.next_attempt_at<=?::timestamptz)
        OR (d.status='leased' AND d.leased_until<=?::timestamptz))
      ORDER BY d.next_attempt_at,d.id LIMIT ? FOR UPDATE OF d SKIP LOCKED`
      )
      .all<{ id: string }>(now.toISOString(), now.toISOString(), limit);
    const rows: DeliveryRow[] = [];
    for (const item of ids) {
      const lease = id('whlease');
      const row = await tx
        .prepare(
          `UPDATE outbound_webhook_deliveries d
        SET status='leased',attempts=d.attempts+1,lease_token=?,
          leased_until=(?::timestamptz + INTERVAL '1 minute'),updated_at=?::timestamptz
        FROM outbound_webhook_subscriptions s
        WHERE d.id=? AND d.subscription_id=s.id AND d.workspace_id=s.workspace_id
        RETURNING d.id,d.workspace_id,d.subscription_id,d.event_id,d.payload_json,
          d.attempts,d.lease_token,s.url,s.active,s.ciphertext,s.iv,s.auth_tag,s.key_version,s.key_id`
        )
        .get<DeliveryRow>(lease, now.toISOString(), now.toISOString(), item.id);
      if (row) rows.push(row);
    }
    return rows;
  });
}

export async function dispatchOutboundWebhookDeliveries(
  db: Db,
  options: {
    now?: Date;
    limit?: number;
    allowedHosts?: readonly string[];
    fetchImpl?: WebhookFetch;
  } = {}
): Promise<{ claimed: number; delivered: number; retried: number; dead: number }> {
  const now = options.now ?? new Date();
  const allowedHosts = options.allowedHosts ?? allowedWebhookHostnames();
  // No configured destination allowlist = no external delivery possible.
  if (!allowedHosts.length) return { claimed: 0, delivered: 0, retried: 0, dead: 0 };
  const rows = await claimDeliveries(db, Math.max(1, Math.min(options.limit ?? 10, 50)), now);
  const result = { claimed: rows.length, delivered: 0, retried: 0, dead: 0 };
  for (const row of rows) {
    let success = false;
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      if (!row.active) throw new Error('Webhook subscription inactive');
      const url = validateWebhookTarget(row.url, allowedHosts);
      const secret = openSecret(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
          keyVersion: Number(row.key_version),
          keyId: row.key_id
        },
        secretContext(row.workspace_id, row.subscription_id)
      );
      const body = JSON.stringify(row.payload_json);
      const timestamp = Math.floor(now.getTime() / 1000);
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          'X-Trevra-Event-Id': row.event_id,
          'X-Trevra-Delivery-Id': row.id,
          'X-Trevra-Signature': signWebhookBody(secret, timestamp, body)
        },
        body
      });
      httpStatus = response.status;
      success = response.status >= 200 && response.status < 300;
      if (!success) error = `HTTP ${response.status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 250) : 'Delivery failed';
    }
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    const newStatus = success ? 'delivered' : exhausted ? 'dead' : 'pending';
    const delayMinutes = Math.min(60, 2 ** Math.max(0, row.attempts - 1));
    const nextAttempt = new Date(now.getTime() + delayMinutes * 60000).toISOString();
    const settled = await db
      .prepare(
        `UPDATE outbound_webhook_deliveries
      SET status=?,lease_token=NULL,leased_until=NULL,next_attempt_at=?::timestamptz,
        last_http_status=?,last_error=?,delivered_at=CASE WHEN ? THEN ?::timestamptz ELSE delivered_at END,
        updated_at=?::timestamptz
      WHERE id=? AND workspace_id=? AND status='leased' AND lease_token=?`
      )
      .run(
        newStatus,
        nextAttempt,
        httpStatus,
        error,
        success,
        now.toISOString(),
        now.toISOString(),
        row.id,
        row.workspace_id,
        row.lease_token
      );
    // If the lease expired and another worker owns it, this worker cannot
    // overwrite the newer decision. It may nevertheless have performed an HTTP
    // write: exactly-once external delivery is impossible; IDs are stable.
    if (!settled.changes) continue;
    if (success) result.delivered++;
    else if (exhausted) result.dead++;
    else result.retried++;
  }
  return result;
}
