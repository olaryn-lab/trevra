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

/**
 * Claim the event in `webhook_events` (migration 058 index). A row already
 * processed or ignored is a duplicate; a row left `received` or `failed` is
 * re-run, which is safe because every handler is idempotent.
 */
async function claimWebhookEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  eventId: string,
  rawBody: Buffer,
  now: Date
): Promise<'claimed' | 'done'> {
  const provider = `hook:${endpoint.provider}`;
  const externalEventId = `${endpoint.id}:${eventId}`;
  const inserted = await db
    .prepare(
      `INSERT INTO webhook_events (id,provider,external_event_id,workspace_id,payload_hash,status,received_at)
       VALUES (?,?,?,?,?,'received',?)
       ON CONFLICT (COALESCE(workspace_id,'@unresolved'),provider,external_event_id) DO NOTHING`
    )
    .run(
      id('webhook'),
      provider,
      externalEventId,
      endpoint.workspaceId,
      createHash('sha256').update(rawBody).digest('hex'),
      now.toISOString()
    );
  if (inserted.changes > 0) return 'claimed';
  const prior = await db
    .prepare(
      'SELECT status FROM webhook_events WHERE workspace_id=? AND provider=? AND external_event_id=?'
    )
    .get<{ status: string }>(endpoint.workspaceId, provider, externalEventId);
  return prior && (prior.status === 'processed' || prior.status === 'ignored') ? 'done' : 'claimed';
}

async function finishWebhookEvent(
  db: Db,
  endpoint: ProviderWebhookEndpoint,
  eventId: string,
  status: 'processed' | 'ignored' | 'failed',
  error: string | null,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `UPDATE webhook_events SET status=?,error=?,processed_at=?
       WHERE workspace_id=? AND provider=? AND external_event_id=?`
    )
    .run(
      status,
      error,
      now.toISOString(),
      endpoint.workspaceId,
      `hook:${endpoint.provider}`,
      `${endpoint.id}:${eventId}`
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

  if ((await claimWebhookEvent(db, endpoint, verified.eventId, rawBody, now)) === 'done') {
    res.status(200).json({ received: true, duplicate: true });
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
