import { createHash } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { id, type Db } from '../db.js';
import { getProviderVerifier } from './registry.js';
import {
  getProviderWebhookEndpointById,
  isProviderWebhookEndpointId,
  readProviderWebhookSecret,
  recordProviderWebhookAccepted,
  recordProviderWebhookRejected
} from './store.js';
import type { ProviderWebhookEndpoint } from './types.js';

const MAX_BODY_BYTES = 1024 * 1024;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// lc-debt: a crashed handler holds its lease for this long before a retry may
// re-run it; upgrade path is a heartbeat or per-event lease token.
const STALE_LEASE_INTERVAL = '2 minutes';

/**
 * Claim the event in `webhook_events` as an atomic lease (migration 058 index).
 * One statement inserts a new row, or takes over a `failed` row or a `received`
 * row whose lease went stale. A returned row means this delivery owns the event.
 * Otherwise the event is `done` (processed or ignored) or `busy` (another
 * delivery holds a fresh lease), so at most one handler runs per event at a time.
 */
async function claimWebhookEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  eventId: string,
  rawBody: Buffer,
  now: Date
): Promise<'claimed' | 'done' | 'busy'> {
  const provider = `hook:${endpoint.provider}`;
  const externalEventId = `${endpoint.id}:${eventId}`;
  const claimed = await db
    .prepare(
      `INSERT INTO webhook_events (id,provider,external_event_id,workspace_id,payload_hash,status,received_at)
       VALUES (?,?,?,?,?,'received',?)
       ON CONFLICT (COALESCE(workspace_id,'@unresolved'),provider,external_event_id)
       DO UPDATE SET status='received', error=NULL, received_at=EXCLUDED.received_at
       WHERE webhook_events.status='failed'
          OR (webhook_events.status='received'
              AND webhook_events.received_at < EXCLUDED.received_at - interval '${STALE_LEASE_INTERVAL}')
       RETURNING id`
    )
    .get<{ id: string }>(
      id('webhook'),
      provider,
      externalEventId,
      endpoint.workspaceId,
      createHash('sha256').update(rawBody).digest('hex'),
      now.toISOString()
    );
  if (claimed) return 'claimed';
  const prior = await db
    .prepare(
      'SELECT status FROM webhook_events WHERE workspace_id=? AND provider=? AND external_event_id=?'
    )
    .get<{ status: string }>(endpoint.workspaceId, provider, externalEventId);
  return prior && (prior.status === 'processed' || prior.status === 'ignored') ? 'done' : 'busy';
}

async function finishWebhookEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  eventId: string,
  status: 'processed' | 'ignored' | 'failed',
  error: string | null,
  claimedAt: Date,
  now: Date
): Promise<void> {
  await db
    .prepare(
      // Only the lease holder may finish: a stale finisher must not overwrite
      // a row another delivery re-claimed or already processed.
      `UPDATE webhook_events SET status=?,error=?,processed_at=?
       WHERE workspace_id=? AND provider=? AND external_event_id=?
         AND status='received' AND received_at=?`
    )
    .run(
      status,
      error,
      now.toISOString(),
      endpoint.workspaceId,
      `hook:${endpoint.provider}`,
      `${endpoint.id}:${eventId}`,
      claimedAt.toISOString()
    );
}

async function handleDelivery(db: Db, req: Request, res: Response, now: Date): Promise<void> {
  const provider = String(req.params.provider ?? '');
  const endpointId = String(req.params.endpointId ?? '');
  const verifier = getProviderVerifier(provider);
  const endpoint =
    verifier && isProviderWebhookEndpointId(endpointId)
      ? await getProviderWebhookEndpointById(db, endpointId)
      : null;
  if (!verifier || !endpoint || endpoint.provider !== provider) {
    res.status(404).json({ error: 'Webhook endpoint not found' });
    return;
  }
  const reject = async (status: number, message: string) => {
    await recordProviderWebhookRejected(db, endpoint.id, now);
    res.status(status).json({ error: message });
  };
  if (endpoint.status !== 'active') return void (await reject(403, 'Webhook endpoint is paused'));

  let secret: string | null = null;
  try {
    secret = await readProviderWebhookSecret(db, endpoint);
  } catch {
    secret = null;
  }
  if (!secret) return void (await reject(503, 'Webhook endpoint secret is unavailable'));

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const verified = verifier.verify(rawBody, req.headers, secret, now);
  if (!verified.ok) return void (await reject(verified.status, verified.error));
  if (!EVENT_ID_RE.test(verified.eventId))
    return void (await reject(400, 'Webhook event id is invalid'));
  await recordProviderWebhookAccepted(db, endpoint.id, now);

  const claim = await claimWebhookEvent(db, endpoint, verified.eventId, rawBody, now);
  if (claim === 'done') {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }
  if (claim === 'busy') {
    res.status(503).json({ error: 'Webhook event is in progress' });
    return;
  }
  try {
    const outcome = await verifier.handle(
      db,
      endpoint,
      { eventId: verified.eventId, eventType: verified.eventType, payload: verified.payload },
      now
    );
    await finishWebhookEvent(
      db,
      endpoint,
      verified.eventId,
      outcome.handled ? 'processed' : 'ignored',
      null,
      now,
      now
    );
    res.status(200).json({ received: true, handled: outcome.handled });
  } catch (error) {
    // Only the error class is stored: messages can carry identifiers or content.
    await finishWebhookEvent(
      db,
      endpoint,
      verified.eventId,
      'failed',
      error instanceof Error ? error.name.slice(0, 120) : 'Error',
      now,
      now
    );
    throw error;
  }
}

/**
 * POST /api/hooks/v1/:provider/:endpointId
 *
 * Register BEFORE the global JSON parser: verifiers sign the exact raw bytes.
 * The endpoint id in the URL decides the workspace; nothing in the payload can.
 * A 5xx makes the provider retry; every handler is idempotent.
 */
export function registerProviderWebhookRoutes(
  app: Express,
  db: Db,
  options: { now?: () => Date } = {}
): void {
  const clock = options.now ?? (() => new Date());
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    // Keyed by endpoint, never by IP: providers deliver from shared address
    // pools, and one endpoint must never spend another endpoint's quota.
    keyGenerator: (req) =>
      `${String(req.params.provider ?? '')}:${String(req.params.endpointId ?? '')}`,
    message: { error: 'Too many webhook deliveries. The provider will retry.' }
  });

  app.post(
    '/api/hooks/v1/:provider/:endpointId',
    limiter,
    express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
    async (req, res, next) => {
      try {
        await handleDelivery(db, req, res, clock());
      } catch (error) {
        next(error);
      }
    }
  );
}
