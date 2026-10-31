/**
 * Merchant-controlled outbound event notifications. Nothing in this module
 * performs provider writes at event creation time: the domain transaction
 * appends one minimal payload per matching subscription to a durable outbox.
 * Dispatch is a leased worker action behind the egress policy in
 * `outbound-webhook-egress.ts` (operator host allowlist, public-address DNS
 * check pinned to the socket, no redirects, bounded time and response size).
 *
 * Consumer contract (see docs/ops/outbound-webhooks.md):
 * - `X-Trevra-Event-Id` is the immutable event occurrence id (also `id` in the
 *   body). `X-Trevra-Delivery-Id` is stable per (subscription, event) across
 *   retries AND owner replays: it is the idempotency key consumers dedupe on.
 * - `X-Trevra-Attempt-Series` is 0 for the original delivery and increments on
 *   every owner replay; `X-Trevra-Attempt` counts attempts within the series.
 * - `X-Trevra-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` -- HMAC-SHA256 of
 *   `<t>.<raw body>`. Outside a rotation overlap there is exactly one `v1`, as
 *   before; during the overlap the newest secret's signature comes first and
 *   the previous secret's second. A verifier accepts the request when ANY `v1`
 *   matches its secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { id, type Db } from './db.js';
import { openSecret, sealSecret, type SecretContext } from './secrets/crypto.js';
import { appendDomainEvent, type DomainEvent } from './control-plane/events.js';
import {
  WEBHOOK_TRANSPORT_LIMITS,
  WebhookEgressError,
  checkWebhookUrl,
  isEgressPolicyCode,
  nodeWebhookTransport,
  resolvePublicAddress,
  systemWebhookResolver,
  vetWebhookDestination,
  webhookEgressPolicy,
  type WebhookEgressPolicy,
  type WebhookReasonCode,
  type WebhookResolver,
  type WebhookTransport
} from './outbound-webhook-egress.js';

export const OUTBOUND_WEBHOOK_EVENTS = [
  'linkedin_campaign.started',
  'linkedin_campaign.stopped',
  'linkedin_campaign.paused',
  'playbook.run.completed',
  'playbook.run.failed'
] as const;
export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];
const allowedEvents = new Set<string>(OUTBOUND_WEBHOOK_EVENTS);

export class OutboundWebhookError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code: string | null = null
  ) {
    super(message);
    this.name = 'OutboundWebhookError';
  }
}
export class OutboundWebhookInputError extends OutboundWebhookError {
  constructor(message: string, code: string | null = null) {
    super(message, 400, code);
    this.name = 'OutboundWebhookInputError';
  }
}

const MAX_ATTEMPTS = 6;
const SIGNATURE_VERSION = 'v1';
export const OUTBOUND_WEBHOOK_REPLAY_CAP = 500;
export const DEFAULT_SECRET_OVERLAP_SECONDS = 24 * 60 * 60;
export const MAX_SECRET_OVERLAP_SECONDS = 7 * 24 * 60 * 60;
/** Auto-disable needs BOTH a long streak of failed attempts and a streak older than a day. */
export const AUTO_DISABLE_MIN_FAILURES = 30;
export const AUTO_DISABLE_MIN_STREAK_MS = 24 * 60 * 60 * 1000;
export const ATTEMPT_RETENTION_DAYS = 30;

function secretContext(workspaceId: string, subscriptionId: string): SecretContext {
  return {
    store: 'outbound_webhook_subscriptions',
    workspaceId,
    seatKey: 'owner',
    kind: `outbound:${subscriptionId}`
  };
}

export function allowedWebhookHostnames(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...webhookEgressPolicy(env).allowedHosts];
}

function policyFrom(
  policy: WebhookEgressPolicy | readonly string[] | undefined
): WebhookEgressPolicy {
  if (!policy) return webhookEgressPolicy();
  if (Array.isArray(policy))
    return { allowedHosts: policy as readonly string[], allowedPorts: [], allowHttp: false };
  return policy as WebhookEgressPolicy;
}

function inputError(error: unknown): unknown {
  return error instanceof WebhookEgressError
    ? new OutboundWebhookInputError(error.message, error.code)
    : error;
}

/** Structural destination check (no DNS). Throws OutboundWebhookInputError with a reason code. */
export function validateWebhookTarget(
  raw: string,
  policy: WebhookEgressPolicy | readonly string[]
): string {
  try {
    return checkWebhookUrl(raw, policyFrom(policy)).toString();
  } catch (error) {
    throw inputError(error);
  }
}

export interface OutboundWebhookEgressOptions {
  policy?: WebhookEgressPolicy;
  resolver?: WebhookResolver;
}

async function vetForStorage(raw: string, egress: OutboundWebhookEgressOptions): Promise<string> {
  try {
    return (
      await vetWebhookDestination(
        raw,
        policyFrom(egress.policy),
        egress.resolver ?? systemWebhookResolver
      )
    ).toString();
  } catch (error) {
    throw inputError(error);
  }
}

function normalizeEventTypes(input: readonly string[]): string[] {
  const eventTypes = [...new Set(input)];
  if (
    !eventTypes.length ||
    eventTypes.length > OUTBOUND_WEBHOOK_EVENTS.length ||
    eventTypes.some((item) => !allowedEvents.has(item))
  )
    throw new OutboundWebhookInputError(
      'Webhook event types must be a nonempty list of supported lifecycle events.'
    );
  return eventTypes;
}

const iso = (column: string) =>
  `TO_CHAR(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SUBSCRIPTION_COLUMNS = `id,workspace_id,url,event_types,active,
  ${iso('created_at')} AS created_at,disabled_reason,${iso('disabled_at')} AS disabled_at,
  ${iso('secret_rotated_at')} AS secret_rotated_at,
  ${iso('previous_secret_expires_at')} AS previous_secret_expires_at,
  consecutive_failures,last_failure_code,${iso('last_failure_at')} AS last_failure_at,
  ${iso('last_success_at')} AS last_success_at`;

export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
  /** `owner` (manual) or `consecutive_failures` (automatic); null while active. */
  disabledReason: 'owner' | 'consecutive_failures' | null;
  disabledAt: string | null;
  secretRotatedAt: string | null;
  /** Set only while the previous signing secret is still being sent alongside the new one. */
  previousSecretExpiresAt: string | null;
  consecutiveFailures: number;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}
interface SubscriptionRow {
  id: string;
  workspace_id: string;
  url: string;
  event_types: string[];
  active: boolean;
  created_at: string;
  disabled_reason: WebhookSubscription['disabledReason'];
  disabled_at: string | null;
  secret_rotated_at: string | null;
  previous_secret_expires_at: string | null;
  consecutive_failures: number;
  last_failure_code: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
}
function serializeSubscription(row: SubscriptionRow, now: Date): WebhookSubscription {
  const previous = row.previous_secret_expires_at;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    url: row.url,
    eventTypes: row.event_types,
    active: row.active,
    createdAt: row.created_at,
    disabledReason: row.disabled_reason,
    disabledAt: row.disabled_at,
    secretRotatedAt: row.secret_rotated_at,
    // Lazy half of the expiry closer: an expired overlap is never reported.
    previousSecretExpiresAt: previous && Date.parse(previous) > now.getTime() ? previous : null,
    consecutiveFailures: Number(row.consecutive_failures),
    lastFailureCode: row.last_failure_code,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at
  };
}

function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

export async function createOutboundWebhookSubscription(
  db: Db,
  input: {
    workspaceId: string;
    url: string;
    eventTypes: readonly string[];
    actorId?: string | null;
  },
  egress: OutboundWebhookEgressOptions = {}
): Promise<{ subscription: WebhookSubscription; signingSecret: string }> {
  const eventTypes = normalizeEventTypes(input.eventTypes);
  const url = await vetForStorage(input.url, egress);
  const subscriptionId = id('owhs');
  const signingSecret = newSigningSecret();
  const sealed = sealSecret(signingSecret, secretContext(input.workspaceId, subscriptionId));
  const row = await db
    .prepare(
      `INSERT INTO outbound_webhook_subscriptions
    (id,workspace_id,url,event_types,ciphertext,iv,auth_tag,key_version,key_id,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING ${SUBSCRIPTION_COLUMNS}`
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
  return { subscription: serializeSubscription(row, new Date()), signingSecret };
}

export async function listOutboundWebhookSubscriptions(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<WebhookSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS}
    FROM outbound_webhook_subscriptions WHERE workspace_id=? ORDER BY created_at,id`
    )
    .all<SubscriptionRow>(workspaceId);
  return rows.map((row) => serializeSubscription(row, now));
}

/** Dead-letter every queued write of a subscription that just stopped being active. */
async function deadLetterOpenDeliveries(
  tx: Db,
  workspaceId: string,
  subscriptionId: string,
  now: Date,
  message: string
): Promise<void> {
  await tx
    .prepare(
      `UPDATE outbound_webhook_deliveries SET status='dead',lease_token=NULL,
      leased_until=NULL,last_error=?,last_reason_code='subscription_inactive',
      dead_at=?::timestamptz,updated_at=?::timestamptz
      WHERE workspace_id=? AND subscription_id=? AND status IN ('pending','leased')`
    )
    .run(message, now.toISOString(), now.toISOString(), workspaceId, subscriptionId);
}

/**
 * Owner edit: destination, event types, and enable/disable. A new URL, and
 * re-enabling, both pass the full egress check (structure + DNS) first.
 * Re-enabling clears the failure streak; it does NOT requeue dead deliveries --
 * that is an explicit replay.
 */
export async function updateOutboundWebhookSubscription(
  db: Db,
  input: {
    workspaceId: string;
    subscriptionId: string;
    url?: string;
    eventTypes?: readonly string[];
    active?: boolean;
    now?: Date;
  },
  egress: OutboundWebhookEgressOptions = {}
): Promise<WebhookSubscription | null> {
  const now = input.now ?? new Date();
  const eventTypes =
    input.eventTypes === undefined ? undefined : normalizeEventTypes(input.eventTypes);
  const current = await db
    .prepare(`SELECT url FROM outbound_webhook_subscriptions WHERE workspace_id=? AND id=?`)
    .get<{ url: string }>(input.workspaceId, input.subscriptionId);
  if (!current) return null;
  // DNS runs before the row lock is taken, never while holding it.
  const vettedUrl =
    input.url !== undefined || input.active === true
      ? await vetForStorage(input.url ?? current.url, egress)
      : undefined;
  return db.transaction(async (tx) => {
    const locked = await tx
      .prepare(
        `SELECT url,active FROM outbound_webhook_subscriptions
        WHERE workspace_id=? AND id=? FOR UPDATE`
      )
      .get<{ url: string; active: boolean }>(input.workspaceId, input.subscriptionId);
    if (!locked) return null;
    if (input.url === undefined && vettedUrl !== undefined && locked.url !== current.url)
      throw new OutboundWebhookError('Subscription changed concurrently; retry.', 409);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.url !== undefined) {
      sets.push('url=?');
      params.push(vettedUrl);
    }
    if (eventTypes) {
      sets.push('event_types=?');
      params.push(eventTypes);
    }
    const enabling = input.active === true && !locked.active;
    const disabling = input.active === false && locked.active;
    if (enabling)
      sets.push(
        'active=TRUE,disabled_reason=NULL,disabled_at=NULL,consecutive_failures=0,failing_since=NULL'
      );
    if (disabling) {
      sets.push(`active=FALSE,disabled_reason='owner',disabled_at=?::timestamptz`);
      params.push(now.toISOString());
    }
    sets.push('updated_at=?::timestamptz');
    params.push(now.toISOString());
    const row = await tx
      .prepare(
        `UPDATE outbound_webhook_subscriptions SET ${sets.join(',')}
        WHERE workspace_id=? AND id=? RETURNING ${SUBSCRIPTION_COLUMNS}`
      )
      .get<SubscriptionRow>(...params, input.workspaceId, input.subscriptionId);
    if (disabling)
      await deadLetterOpenDeliveries(
        tx,
        input.workspaceId,
        input.subscriptionId,
        now,
        'Subscription deactivated'
      );
    return row ? serializeSubscription(row, now) : null;
  });
}

export async function deactivateOutboundWebhookSubscription(
  db: Db,
  workspaceId: string,
  subscriptionId: string,
  now: Date = new Date()
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx
      .prepare(
        `UPDATE outbound_webhook_subscriptions
      SET active=FALSE,disabled_reason='owner',disabled_at=?::timestamptz,updated_at=?::timestamptz
      WHERE workspace_id=? AND id=? AND active=TRUE`
      )
      .run(now.toISOString(), now.toISOString(), workspaceId, subscriptionId);
    await deadLetterOpenDeliveries(
      tx,
      workspaceId,
      subscriptionId,
      now,
      'Subscription deactivated'
    );
    return result.changes > 0;
  });
}

/**
 * Rotate the signing secret. The new secret is returned exactly once. For
 * `overlapSeconds` the previous secret keeps signing alongside it (second
 * `v1`), then expires: lazily at signing time, and physically via
 * {@link expireOutboundWebhookSecrets} in the worker. Rotating again inside an
 * overlap drops the older previous secret -- at most two are ever live.
 * `overlapSeconds = 0` revokes the old secret immediately.
 */
export async function rotateOutboundWebhookSecret(
  db: Db,
  input: {
    workspaceId: string;
    subscriptionId: string;
    overlapSeconds?: number;
    actorId?: string | null;
    now?: Date;
  }
): Promise<{ subscription: WebhookSubscription; signingSecret: string } | null> {
  const now = input.now ?? new Date();
  const overlap = input.overlapSeconds ?? DEFAULT_SECRET_OVERLAP_SECONDS;
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > MAX_SECRET_OVERLAP_SECONDS)
    throw new OutboundWebhookInputError(
      `Secret overlap must be between 0 and ${MAX_SECRET_OVERLAP_SECONDS} seconds.`
    );
  return db.transaction(async (tx) => {
    const locked = await tx
      .prepare(
        `SELECT id FROM outbound_webhook_subscriptions WHERE workspace_id=? AND id=? FOR UPDATE`
      )
      .get<{ id: string }>(input.workspaceId, input.subscriptionId);
    if (!locked) return null;
    const signingSecret = newSigningSecret();
    const sealed = sealSecret(
      signingSecret,
      secretContext(input.workspaceId, input.subscriptionId)
    );
    const keep = overlap > 0;
    const expiresAt = keep ? new Date(now.getTime() + overlap * 1000).toISOString() : null;
    // Right-hand column references read the OLD row: the outgoing secret moves
    // into the previous_* slot in the same statement that installs the new one.
    const row = await tx
      .prepare(
        `UPDATE outbound_webhook_subscriptions SET
        previous_ciphertext=CASE WHEN ? THEN ciphertext END,
        previous_iv=CASE WHEN ? THEN iv END,
        previous_auth_tag=CASE WHEN ? THEN auth_tag END,
        previous_key_version=CASE WHEN ? THEN key_version END,
        previous_key_id=CASE WHEN ? THEN key_id END,
        previous_secret_expires_at=?::timestamptz,
        ciphertext=?,iv=?,auth_tag=?,key_version=?,key_id=?,
        secret_rotated_at=?::timestamptz,updated_at=?::timestamptz
        WHERE workspace_id=? AND id=? RETURNING ${SUBSCRIPTION_COLUMNS}`
      )
      .get<SubscriptionRow>(
        keep,
        keep,
        keep,
        keep,
        keep,
        expiresAt,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.keyVersion,
        sealed.keyId,
        now.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.subscriptionId
      );
    if (!row) return null;
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'outbound_webhook_subscription',
      streamId: input.subscriptionId,
      eventType: 'outbound_webhook.secret_rotated',
      actorType: 'user',
      actorId: input.actorId ?? null,
      payload: { overlapSeconds: overlap, previousSecretExpiresAt: expiresAt },
      occurredAt: now
    });
    return { subscription: serializeSubscription(row, now), signingSecret };
  });
}

/** Closer for rotation overlaps: physically drop previous secrets past their expiry. */
export async function expireOutboundWebhookSecrets(
  db: Db,
  now: Date = new Date()
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE outbound_webhook_subscriptions SET previous_ciphertext=NULL,previous_iv=NULL,
      previous_auth_tag=NULL,previous_key_version=NULL,previous_key_id=NULL,
      previous_secret_expires_at=NULL
      WHERE previous_secret_expires_at<=?::timestamptz`
    )
    .run(now.toISOString());
  return result.changes;
}

/**
 * Owner recovery for dead-lettered deliveries: one delivery, or in bulk for a
 * subscription (capped at {@link OUTBOUND_WEBHOOK_REPLAY_CAP}). A replay keeps
 * the delivery row -- same event occurrence id, same payload, same
 * `X-Trevra-Delivery-Id` -- and opens a new attempt series with a fresh retry
 * budget. Refused while the subscription is disabled; a deleted subscription
 * is simply not found. Audited as a domain event in the same transaction.
 */
export async function replayOutboundWebhookDeliveries(
  db: Db,
  input: {
    workspaceId: string;
    subscriptionId: string;
    deliveryId?: string;
    /** Bulk only: replay the oldest N dead deliveries. Required past the cap. */
    limit?: number;
    actorId?: string | null;
    now?: Date;
  }
): Promise<{ replayed: number; deliveryIds: string[] }> {
  const now = input.now ?? new Date();
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > OUTBOUND_WEBHOOK_REPLAY_CAP)
  )
    throw new OutboundWebhookInputError(
      `Replay limit must be between 1 and ${OUTBOUND_WEBHOOK_REPLAY_CAP}.`,
      'replay_cap_exceeded'
    );
  return db.transaction(async (tx) => {
    const subscription = await tx
      .prepare(
        `SELECT active FROM outbound_webhook_subscriptions
        WHERE workspace_id=? AND id=? FOR UPDATE`
      )
      .get<{ active: boolean }>(input.workspaceId, input.subscriptionId);
    if (!subscription) throw new OutboundWebhookError('Subscription not found.', 404);
    if (!subscription.active)
      throw new OutboundWebhookError(
        'Subscription is disabled. Re-enable it before replaying dead-lettered deliveries.',
        409,
        'subscription_inactive'
      );
    let ids: string[];
    if (input.deliveryId !== undefined) {
      const delivery = await tx
        .prepare(
          `SELECT id,status FROM outbound_webhook_deliveries
          WHERE workspace_id=? AND subscription_id=? AND id=? FOR UPDATE`
        )
        .get<{ id: string; status: string }>(
          input.workspaceId,
          input.subscriptionId,
          input.deliveryId
        );
      if (!delivery) throw new OutboundWebhookError('Delivery not found.', 404);
      if (delivery.status !== 'dead')
        throw new OutboundWebhookError(
          'Only dead-lettered deliveries can be replayed.',
          409,
          'not_dead'
        );
      ids = [delivery.id];
    } else {
      const count = await tx
        .prepare(
          `SELECT COUNT(*)::int AS total FROM outbound_webhook_deliveries
          WHERE workspace_id=? AND subscription_id=? AND status='dead'`
        )
        .get<{ total: number }>(input.workspaceId, input.subscriptionId);
      const total = Number(count?.total ?? 0);
      if (input.limit === undefined && total > OUTBOUND_WEBHOOK_REPLAY_CAP)
        throw new OutboundWebhookInputError(
          `${total} dead-lettered deliveries exceed the bulk replay cap of ${OUTBOUND_WEBHOOK_REPLAY_CAP}. ` +
            `Replay the oldest in batches by passing a limit of at most ${OUTBOUND_WEBHOOK_REPLAY_CAP}.`,
          'replay_cap_exceeded'
        );
      const rows = await tx
        .prepare(
          `SELECT id FROM outbound_webhook_deliveries
          WHERE workspace_id=? AND subscription_id=? AND status='dead'
          ORDER BY created_at,id LIMIT ? FOR UPDATE`
        )
        .all<{ id: string }>(
          input.workspaceId,
          input.subscriptionId,
          input.limit ?? OUTBOUND_WEBHOOK_REPLAY_CAP
        );
      ids = rows.map((row) => row.id);
    }
    if (!ids.length) return { replayed: 0, deliveryIds: [] };
    const result = await tx
      .prepare(
        `UPDATE outbound_webhook_deliveries SET status='pending',attempts=0,
        attempt_series=attempt_series+1,next_attempt_at=?::timestamptz,lease_token=NULL,
        leased_until=NULL,dead_at=NULL,replayed_at=?::timestamptz,updated_at=?::timestamptz
        WHERE workspace_id=? AND subscription_id=? AND status='dead' AND id=ANY(?::text[])`
      )
      .run(
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.subscriptionId,
        ids
      );
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'outbound_webhook_subscription',
      streamId: input.subscriptionId,
      eventType: 'outbound_webhook.deliveries_replayed',
      actorType: 'user',
      actorId: input.actorId ?? null,
      payload: {
        mode: input.deliveryId !== undefined ? 'single' : 'bulk',
        count: result.changes,
        deliveryIds: ids
      },
      occurredAt: now
    });
    return { replayed: result.changes, deliveryIds: ids };
  });
}

export interface OutboundWebhookDeliverySummary {
  id: string;
  eventId: string;
  status: 'pending' | 'leased' | 'delivered' | 'dead';
  /** Attempts within the current series. */
  attempts: number;
  /** 0 for the original delivery, +1 per owner replay. */
  attemptSeries: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastReasonCode: string | null;
  createdAt: string;
  deliveredAt: string | null;
  deadAt: string | null;
  replayedAt: string | null;
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
      `SELECT id,event_id,status,attempts,attempt_series,last_http_status,last_error,
      last_reason_code,${iso('created_at')} AS created_at,${iso('delivered_at')} AS delivered_at,
      ${iso('dead_at')} AS dead_at,${iso('replayed_at')} AS replayed_at
    FROM outbound_webhook_deliveries WHERE workspace_id=? AND subscription_id=?
    ORDER BY created_at DESC,id LIMIT ?`
    )
    .all<{
      id: string;
      event_id: string;
      status: OutboundWebhookDeliverySummary['status'];
      attempts: number;
      attempt_series: number;
      last_http_status: number | null;
      last_error: string | null;
      last_reason_code: string | null;
      created_at: string;
      delivered_at: string | null;
      dead_at: string | null;
      replayed_at: string | null;
    }>(workspaceId, subscriptionId, Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    attempts: Number(row.attempts),
    attemptSeries: Number(row.attempt_series),
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    lastReasonCode: row.last_reason_code,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    deadAt: row.dead_at,
    replayedAt: row.replayed_at
  }));
}

export interface OutboundWebhookWindowStats {
  /** Deliveries that succeeded inside the window. */
  delivered: number;
  /** Failed or policy-blocked ATTEMPTS inside the window. */
  failed: number;
  /** Deliveries created inside the window and still queued or in flight. */
  pending: number;
  /** Deliveries dead-lettered inside the window. */
  dead: number;
}
export interface OutboundWebhookStats {
  last24h: OutboundWebhookWindowStats;
  last7d: OutboundWebhookWindowStats;
  consecutiveFailures: number;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

export async function getOutboundWebhookStats(
  db: Db,
  workspaceId: string,
  subscriptionId: string,
  now: Date = new Date()
): Promise<OutboundWebhookStats | null> {
  const subscription = await db
    .prepare(
      `SELECT consecutive_failures,last_failure_code,${iso('last_failure_at')} AS last_failure_at,
      ${iso('last_success_at')} AS last_success_at
      FROM outbound_webhook_subscriptions WHERE workspace_id=? AND id=?`
    )
    .get<{
      consecutive_failures: number;
      last_failure_code: string | null;
      last_failure_at: string | null;
      last_success_at: string | null;
    }>(workspaceId, subscriptionId);
  if (!subscription) return null;
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const deliveries = await db
    .prepare(
      `SELECT
      COUNT(*) FILTER (WHERE status='delivered' AND delivered_at>=?::timestamptz)::int AS delivered_day,
      COUNT(*) FILTER (WHERE status='delivered' AND delivered_at>=?::timestamptz)::int AS delivered_week,
      COUNT(*) FILTER (WHERE status IN ('pending','leased') AND created_at>=?::timestamptz)::int AS pending_day,
      COUNT(*) FILTER (WHERE status IN ('pending','leased') AND created_at>=?::timestamptz)::int AS pending_week,
      COUNT(*) FILTER (WHERE status='dead' AND COALESCE(dead_at,updated_at)>=?::timestamptz)::int AS dead_day,
      COUNT(*) FILTER (WHERE status='dead' AND COALESCE(dead_at,updated_at)>=?::timestamptz)::int AS dead_week
      FROM outbound_webhook_deliveries WHERE workspace_id=? AND subscription_id=?`
    )
    .get<Record<string, number>>(day, week, day, week, day, week, workspaceId, subscriptionId);
  const attempts = await db
    .prepare(
      `SELECT
      COUNT(*) FILTER (WHERE outcome<>'delivered' AND attempted_at>=?::timestamptz)::int AS failed_day,
      COUNT(*) FILTER (WHERE outcome<>'delivered')::int AS failed_week
      FROM outbound_webhook_delivery_attempts
      WHERE workspace_id=? AND subscription_id=? AND attempted_at>=?::timestamptz`
    )
    .get<Record<string, number>>(day, workspaceId, subscriptionId, week);
  const window = (suffix: 'day' | 'week'): OutboundWebhookWindowStats => ({
    delivered: Number(deliveries?.[`delivered_${suffix}`] ?? 0),
    failed: Number(attempts?.[`failed_${suffix}`] ?? 0),
    pending: Number(deliveries?.[`pending_${suffix}`] ?? 0),
    dead: Number(deliveries?.[`dead_${suffix}`] ?? 0)
  });
  return {
    last24h: window('day'),
    last7d: window('week'),
    consecutiveFailures: Number(subscription.consecutive_failures),
    lastFailureCode: subscription.last_failure_code,
    lastFailureAt: subscription.last_failure_at,
    lastSuccessAt: subscription.last_success_at
  };
}

export interface OutboundWebhookAttemptSummary {
  id: string;
  deliveryId: string;
  eventId: string;
  attemptSeries: number;
  attemptNumber: number;
  outcome: 'delivered' | 'failed' | 'blocked';
  httpStatus: number | null;
  latencyMs: number | null;
  reasonCode: string | null;
  attemptedAt: string;
}

/** Recent attempts. Response bodies are never stored, so none can be shown. */
export async function listOutboundWebhookAttempts(
  db: Db,
  workspaceId: string,
  subscriptionId: string,
  limit = 50
): Promise<OutboundWebhookAttemptSummary[] | null> {
  const subscription = await db
    .prepare(`SELECT id FROM outbound_webhook_subscriptions WHERE workspace_id=? AND id=?`)
    .get<{ id: string }>(workspaceId, subscriptionId);
  if (!subscription) return null;
  const rows = await db
    .prepare(
      `SELECT a.id,a.delivery_id,d.event_id,a.attempt_series,a.attempt_number,a.outcome,
      a.http_status,a.latency_ms,a.reason_code,${iso('a.attempted_at')} AS attempted_at
      FROM outbound_webhook_delivery_attempts a
      JOIN outbound_webhook_deliveries d ON d.id=a.delivery_id AND d.workspace_id=a.workspace_id
      WHERE a.workspace_id=? AND a.subscription_id=?
      ORDER BY a.attempted_at DESC,a.id DESC LIMIT ?`
    )
    .all<{
      id: string;
      delivery_id: string;
      event_id: string;
      attempt_series: number;
      attempt_number: number;
      outcome: OutboundWebhookAttemptSummary['outcome'];
      http_status: number | null;
      latency_ms: number | null;
      reason_code: string | null;
      attempted_at: string;
    }>(workspaceId, subscriptionId, Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => ({
    id: row.id,
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    attemptSeries: Number(row.attempt_series),
    attemptNumber: Number(row.attempt_number),
    outcome: row.outcome,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    reasonCode: row.reason_code,
    attemptedAt: row.attempted_at
  }));
}

/** Retention closer for the attempt log; bounded per call so a sweep never runs long. */
export async function pruneOutboundWebhookAttempts(
  db: Db,
  now: Date = new Date(),
  retentionDays = ATTEMPT_RETENTION_DAYS,
  batch = 5000
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const result = await db
    .prepare(
      `DELETE FROM outbound_webhook_delivery_attempts WHERE id IN (
        SELECT id FROM outbound_webhook_delivery_attempts
        WHERE attempted_at<?::timestamptz ORDER BY attempted_at LIMIT ?)`
    )
    .run(cutoff, batch);
  return result.changes;
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
  attempt_series: number;
  lease_token: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  key_id: string | null;
  previous_ciphertext: Buffer | null;
  previous_iv: Buffer | null;
  previous_auth_tag: Buffer | null;
  previous_key_version: number | null;
  previous_key_id: string | null;
  previous_live: boolean;
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** `t=<unix>,v1=<hex>[,v1=<hex>]`: one `v1` per live secret, newest first. */
export function signWebhookBody(
  secrets: string | readonly string[],
  timestamp: number,
  body: string
): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets;
  return [
    `t=${timestamp}`,
    ...list.map((secret) => `${SIGNATURE_VERSION}=${hmac(secret, timestamp, body)}`)
  ].join(',');
}

/** Reference verifier for consumers: accepts when ANY `v1` matches and `t` is fresh. */
export function verifyWebhookSignature(
  header: string,
  secret: string,
  body: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {}
): boolean {
  const parts = header.split(',').map((part) => part.trim());
  const timestamps = parts.filter((part) => part.startsWith('t=')).map((part) => part.slice(2));
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0])) return false;
  const timestamp = Number(timestamps[0]);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  return parts
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION}=`))
    .map((part) => part.slice(SIGNATURE_VERSION.length + 1))
    .some((candidate) => {
      if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
      return timingSafeEqual(Buffer.from(candidate, 'hex'), expected);
    });
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
          d.attempts,d.attempt_series,d.lease_token,s.url,s.active,s.ciphertext,s.iv,s.auth_tag,
          s.key_version,s.key_id,s.previous_ciphertext,s.previous_iv,s.previous_auth_tag,
          s.previous_key_version,s.previous_key_id,
          COALESCE(s.previous_secret_expires_at>?::timestamptz,FALSE) AS previous_live`
        )
        .get<DeliveryRow>(lease, now.toISOString(), now.toISOString(), item.id, now.toISOString());
      if (row) rows.push(row);
    }
    return rows;
  });
}

/** Live signing secrets, newest first. The previous one is included only inside its overlap. */
function openSigningSecrets(row: DeliveryRow): string[] {
  const context = secretContext(row.workspace_id, row.subscription_id);
  let current: string;
  try {
    current = openSecret(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: Number(row.key_version),
        keyId: row.key_id
      },
      context
    );
  } catch {
    throw new WebhookEgressError(
      'secret_unavailable',
      'Webhook signing secret could not be opened.'
    );
  }
  if (
    !row.previous_live ||
    !row.previous_ciphertext ||
    !row.previous_iv ||
    !row.previous_auth_tag ||
    row.previous_key_version === null
  )
    return [current];
  try {
    return [
      current,
      openSecret(
        {
          ciphertext: row.previous_ciphertext,
          iv: row.previous_iv,
          authTag: row.previous_auth_tag,
          keyVersion: Number(row.previous_key_version),
          keyId: row.previous_key_id
        },
        context
      )
    ];
  } catch {
    // The overlap is a courtesy to the consumer; an unreadable previous secret
    // must not block delivery signed with the current one.
    return [current];
  }
}

interface AttemptOutcome {
  success: boolean;
  httpStatus: number | null;
  reasonCode: WebhookReasonCode | null;
  error: string | null;
  latencyMs: number | null;
}

async function attemptDelivery(
  row: DeliveryRow,
  now: Date,
  policy: WebhookEgressPolicy,
  resolver: WebhookResolver,
  transport: WebhookTransport,
  limits: typeof WEBHOOK_TRANSPORT_LIMITS
): Promise<AttemptOutcome> {
  let httpStatus: number | null = null;
  let latencyMs: number | null = null;
  try {
    if (!row.active)
      throw new WebhookEgressError('subscription_inactive', 'Webhook subscription inactive.');
    const url = checkWebhookUrl(row.url, policy);
    const secrets = openSigningSecrets(row);
    // Resolve exactly once per attempt; the transport is pinned to this answer.
    const target = await resolvePublicAddress(url.hostname, resolver);
    const body = JSON.stringify(row.payload_json);
    const timestamp = Math.floor(now.getTime() / 1000);
    const started = performance.now();
    const response = await transport({
      url,
      address: target.address,
      family: target.family,
      headers: {
        'Content-Type': 'application/json',
        'X-Trevra-Event-Id': row.event_id,
        'X-Trevra-Delivery-Id': row.id,
        'X-Trevra-Attempt-Series': String(row.attempt_series),
        'X-Trevra-Attempt': String(row.attempts),
        'X-Trevra-Signature': signWebhookBody(secrets, timestamp, body)
      },
      body,
      ...limits
    }).finally(() => {
      latencyMs = Math.max(0, Math.round(performance.now() - started));
    });
    const status = response.status;
    httpStatus = status;
    if (status >= 200 && status < 300)
      return { success: true, httpStatus: status, reasonCode: null, error: null, latencyMs };
    if (status >= 300 && status < 400)
      return {
        success: false,
        httpStatus: status,
        reasonCode: 'redirect_not_followed',
        error: `HTTP ${status} redirect not followed`,
        latencyMs
      };
    return {
      success: false,
      httpStatus: status,
      reasonCode: 'http_error',
      error: `HTTP ${status}`,
      latencyMs
    };
  } catch (cause) {
    if (cause instanceof WebhookEgressError)
      return {
        success: false,
        httpStatus: cause.httpStatus ?? httpStatus,
        reasonCode: cause.code,
        error: cause.message,
        latencyMs
      };
    return {
      success: false,
      httpStatus,
      reasonCode: 'connection_failed',
      error: 'Delivery failed',
      latencyMs
    };
  }
}

/**
 * Settle one leased attempt. Locks the subscription BEFORE the delivery -- the
 * same order as deactivate, update and replay -- then records the attempt,
 * the failure streak, and, past the auto-disable threshold, disables the
 * subscription and dead-letters its queue. Returns null when the lease was lost.
 */
async function settleAttempt(
  db: Db,
  row: DeliveryRow,
  outcome: AttemptOutcome,
  now: Date
): Promise<'delivered' | 'retried' | 'dead' | null> {
  const exhausted = row.attempts >= MAX_ATTEMPTS;
  const status = outcome.success ? 'delivered' : exhausted ? 'dead' : 'pending';
  const delayMinutes = Math.min(60, 2 ** Math.max(0, row.attempts - 1));
  const nextAttempt = new Date(now.getTime() + delayMinutes * 60000).toISOString();
  const at = now.toISOString();
  return db.transaction(async (tx) => {
    const subscription = await tx
      .prepare(
        `SELECT id FROM outbound_webhook_subscriptions WHERE id=? AND workspace_id=? FOR UPDATE`
      )
      .get<{ id: string }>(row.subscription_id, row.workspace_id);
    if (!subscription) return null;
    const settled = await tx
      .prepare(
        `UPDATE outbound_webhook_deliveries
      SET status=?,lease_token=NULL,leased_until=NULL,next_attempt_at=?::timestamptz,
        last_http_status=?,last_error=?,last_reason_code=?,
        delivered_at=CASE WHEN ? THEN ?::timestamptz ELSE delivered_at END,
        dead_at=CASE WHEN ? THEN ?::timestamptz ELSE NULL END,
        updated_at=?::timestamptz
      WHERE id=? AND workspace_id=? AND status='leased' AND lease_token=?`
      )
      .run(
        status,
        nextAttempt,
        outcome.httpStatus,
        outcome.error,
        outcome.reasonCode,
        outcome.success,
        at,
        status === 'dead',
        at,
        at,
        row.id,
        row.workspace_id,
        row.lease_token
      );
    // If the lease expired and another worker owns it, this worker cannot
    // overwrite the newer decision. It may nevertheless have performed an HTTP
    // write: exactly-once external delivery is impossible; IDs are stable.
    if (!settled.changes) return null;
    await tx
      .prepare(
        `INSERT INTO outbound_webhook_delivery_attempts
        (id,workspace_id,subscription_id,delivery_id,attempt_series,attempt_number,outcome,
          http_status,latency_ms,reason_code,attempted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?::timestamptz)
        ON CONFLICT (delivery_id,attempt_series,attempt_number) DO NOTHING`
      )
      .run(
        id('owha'),
        row.workspace_id,
        row.subscription_id,
        row.id,
        Number(row.attempt_series),
        Number(row.attempts),
        outcome.success
          ? 'delivered'
          : outcome.reasonCode && isEgressPolicyCode(outcome.reasonCode)
            ? 'blocked'
            : 'failed',
        outcome.httpStatus,
        outcome.latencyMs,
        outcome.reasonCode,
        at
      );
    if (outcome.success) {
      await tx
        .prepare(
          `UPDATE outbound_webhook_subscriptions
          SET consecutive_failures=0,failing_since=NULL,last_success_at=?::timestamptz
          WHERE id=? AND workspace_id=?`
        )
        .run(at, row.subscription_id, row.workspace_id);
      return 'delivered';
    }
    const streak = await tx
      .prepare(
        `UPDATE outbound_webhook_subscriptions
        SET consecutive_failures=consecutive_failures+1,
          failing_since=COALESCE(failing_since,?::timestamptz),
          last_failure_code=?,last_failure_at=?::timestamptz
        WHERE id=? AND workspace_id=?
        RETURNING active,consecutive_failures,(failing_since<=?::timestamptz) AS streak_aged`
      )
      .get<{ active: boolean; consecutive_failures: number; streak_aged: boolean }>(
        at,
        outcome.reasonCode,
        at,
        row.subscription_id,
        row.workspace_id,
        new Date(now.getTime() - AUTO_DISABLE_MIN_STREAK_MS).toISOString()
      );
    if (
      streak?.active &&
      streak.streak_aged &&
      Number(streak.consecutive_failures) >= AUTO_DISABLE_MIN_FAILURES
    ) {
      await tx
        .prepare(
          `UPDATE outbound_webhook_subscriptions SET active=FALSE,
          disabled_reason='consecutive_failures',disabled_at=?::timestamptz,updated_at=?::timestamptz
          WHERE id=? AND workspace_id=? AND active=TRUE`
        )
        .run(at, at, row.subscription_id, row.workspace_id);
      await deadLetterOpenDeliveries(
        tx,
        row.workspace_id,
        row.subscription_id,
        now,
        'Subscription auto-disabled after repeated delivery failures'
      );
    }
    return status === 'dead' ? 'dead' : 'retried';
  });
}

export async function dispatchOutboundWebhookDeliveries(
  db: Db,
  options: {
    now?: Date;
    limit?: number;
    policy?: WebhookEgressPolicy;
    resolver?: WebhookResolver;
    transport?: WebhookTransport;
    limits?: Partial<typeof WEBHOOK_TRANSPORT_LIMITS>;
  } = {}
): Promise<{ claimed: number; delivered: number; retried: number; dead: number }> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? webhookEgressPolicy();
  // No configured destination allowlist = no external delivery possible.
  if (!policy.allowedHosts.length) return { claimed: 0, delivered: 0, retried: 0, dead: 0 };
  const resolver = options.resolver ?? systemWebhookResolver;
  const transport = options.transport ?? nodeWebhookTransport;
  const limits = { ...WEBHOOK_TRANSPORT_LIMITS, ...options.limits };
  const rows = await claimDeliveries(db, Math.max(1, Math.min(options.limit ?? 10, 50)), now);
  const result = { claimed: rows.length, delivered: 0, retried: 0, dead: 0 };
  for (const row of rows) {
    const outcome = await attemptDelivery(row, now, policy, resolver, transport, limits);
    const settled = await settleAttempt(db, row, outcome, now);
    if (settled) result[settled]++;
  }
  return result;
}
