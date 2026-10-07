import { createHmac, randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { resealSecrets, secretsCustodyReport } from '../secrets/custody.js';
import {
  ProviderWebhookError,
  createProviderWebhookEndpoint,
  draftProviderWebhookEndpointId,
  getProviderWebhookEndpointById,
  registerProviderVerifier,
  registerProviderWebhookRoutes,
  setProviderWebhookEndpointStatus,
  type ProviderWebhookEndpoint,
  type ProviderWebhookVerifier
} from './index.js';

const WS = 'ws_provider_hooks';
const OTHER = 'ws_provider_hooks_other';
const USER = 'usr_provider_hooks';
const OTHER_USER = 'usr_provider_hooks_other';
const SECRET = `test_${randomBytes(16).toString('hex')}`;
const handled: string[] = [];
const failOnce = new Set<string>();

// A stand-in verifier on the 'calcom' slot: HMAC of the raw body.
const fakeVerifier: ProviderWebhookVerifier = {
  provider: 'calcom',
  verify(rawBody, headers, secret) {
    const signature = String(headers['x-test-signature'] ?? '');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (signature !== expected) return { ok: false, status: 400, error: 'Invalid test signature' };
    const payload = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string };
    return { ok: true, eventId: payload.id, eventType: payload.type, payload };
  },
  async handle(_db, _endpoint, event) {
    handled.push(event.eventId);
    if (event.eventType === 'boom') throw new Error('handler exploded');
    if (failOnce.delete(event.eventId)) throw new Error('transient failure');
    return { handled: event.eventType !== 'ignored' };
  }
};

let db: Db;
let app: Express;
let endpoint: ProviderWebhookEndpoint;

function deliver(
  endpointId: string,
  body: { id: string; type: string },
  secret = SECRET,
  provider = 'calcom'
) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(`/api/hooks/v1/${provider}/${endpointId}`)
    .set('Content-Type', 'application/json')
    .set('X-Test-Signature', createHmac('sha256', secret).update(raw).digest('hex'))
    .send(raw);
}

async function counts(endpointId: string) {
  const row = await getProviderWebhookEndpointById(db, endpointId);
  return { accepted: row!.acceptedCount, rejected: row!.rejectedCount };
}

async function eventStatus(eventId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT status FROM webhook_events
       WHERE workspace_id=? AND provider='hook:calcom' AND external_event_id=?`
    )
    .get<{ status: string }>(WS, `${endpoint.id}:${eventId}`);
  return row?.status ?? null;
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const [workspaceId, userId] of [
    [WS, USER],
    [OTHER, OTHER_USER]
  ]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, new Date().toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, `${userId}@hooks.test`, userId, new Date().toISOString());
  }
  registerProviderVerifier(fakeVerifier);
  endpoint = await createProviderWebhookEndpoint(db, {
    workspaceId: WS,
    actorUserId: USER,
    provider: 'calcom',
    signingSecret: SECRET
  });
  app = express();
  registerProviderWebhookRoutes(app, db);
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal server error' });
  });
});

beforeEach(() => {
  handled.length = 0;
  failOnce.clear();
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  await db?.close();
});

describe('provider webhook endpoint route', () => {
  it('verifies, handles once, and answers a redelivery as a duplicate', async () => {
    const first = await deliver(endpoint.id, { id: 'evt_ok_1', type: 'ok' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, handled: true });
    const again = await deliver(endpoint.id, { id: 'evt_ok_1', type: 'ok' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(handled).toEqual(['evt_ok_1']);
    expect(await eventStatus('evt_ok_1')).toBe('processed');

    const ignored = await deliver(endpoint.id, { id: 'evt_ignored_1', type: 'ignored' });
    expect(ignored.body).toEqual({ received: true, handled: false });
    expect(await eventStatus('evt_ignored_1')).toBe('ignored');
    const ignoredAgain = await deliver(endpoint.id, { id: 'evt_ignored_1', type: 'ignored' });
    expect(ignoredAgain.body).toEqual({ received: true, duplicate: true });
    expect(handled).toEqual(['evt_ok_1', 'evt_ignored_1']);
  });

  it('rejects a bad signature and a paused endpoint, counts both, and writes nothing', async () => {
    const before = await counts(endpoint.id);
    const forged = await deliver(endpoint.id, { id: 'evt_forged', type: 'ok' }, 'wrong-secret');
    expect(forged.status).toBe(400);

    await setProviderWebhookEndpointStatus(db, {
      workspaceId: WS,
      endpointId: endpoint.id,
      status: 'disabled',
      actorUserId: USER
    });
    const paused = await deliver(endpoint.id, { id: 'evt_paused', type: 'ok' });
    expect(paused.status).toBe(403);
    await setProviderWebhookEndpointStatus(db, {
      workspaceId: WS,
      endpointId: endpoint.id,
      status: 'active',
      actorUserId: USER
    });

    expect(await counts(endpoint.id)).toEqual({
      accepted: before.accepted,
      rejected: before.rejected + 2
    });
    expect(handled).toEqual([]);
    expect(await eventStatus('evt_forged')).toBeNull();
    expect(await eventStatus('evt_paused')).toBeNull();
  });

  it('marks a handler failure failed and lets the provider retry it', async () => {
    const failed = await deliver(endpoint.id, { id: 'evt_boom', type: 'boom' });
    expect(failed.status).toBe(500);
    expect(await eventStatus('evt_boom')).toBe('failed');
    const error = await db
      .prepare(`SELECT error FROM webhook_events WHERE workspace_id=? AND external_event_id=?`)
      .get<{ error: string }>(WS, `${endpoint.id}:evt_boom`);
    expect(error?.error).toBe('Error');
    const retried = await deliver(endpoint.id, { id: 'evt_boom', type: 'boom' });
    expect(retried.status).toBe(500);
    expect(handled).toEqual(['evt_boom', 'evt_boom']);
  });

  it('converges: a failed event is re-run on retry, then answers as a duplicate', async () => {
    failOnce.add('evt_flaky');
    const failed = await deliver(endpoint.id, { id: 'evt_flaky', type: 'ok' });
    expect(failed.status).toBe(500);
    expect(await eventStatus('evt_flaky')).toBe('failed');
    const retried = await deliver(endpoint.id, { id: 'evt_flaky', type: 'ok' });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ received: true, handled: true });
    expect(await eventStatus('evt_flaky')).toBe('processed');
    const row = await db
      .prepare(`SELECT error FROM webhook_events WHERE workspace_id=? AND external_event_id=?`)
      .get<{ error: string | null }>(WS, `${endpoint.id}:evt_flaky`);
    expect(row?.error).toBeNull();
    const again = await deliver(endpoint.id, { id: 'evt_flaky', type: 'ok' });
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(handled).toEqual(['evt_flaky', 'evt_flaky']);
  });

  it('answers 404 for an unknown endpoint or a provider that does not match', async () => {
    expect(
      (await deliver(draftProviderWebhookEndpointId(), { id: 'evt_x', type: 'ok' })).status
    ).toBe(404);
    expect((await deliver('not-an-endpoint', { id: 'evt_x', type: 'ok' })).status).toBe(404);
    expect((await deliver(endpoint.id, { id: 'evt_x', type: 'ok' }, SECRET, 'stripe')).status).toBe(
      404
    );
    expect(handled).toEqual([]);
  });
});

describe('provider webhook endpoint store', () => {
  it('creates endpoints idempotently and never across workspaces', async () => {
    const endpointId = draftProviderWebhookEndpointId();
    const created = await createProviderWebhookEndpoint(db, {
      workspaceId: WS,
      actorUserId: USER,
      provider: 'calcom',
      signingSecret: SECRET,
      endpointId
    });
    const repeated = await createProviderWebhookEndpoint(db, {
      workspaceId: WS,
      actorUserId: USER,
      provider: 'calcom',
      signingSecret: SECRET,
      endpointId
    });
    expect(repeated.id).toBe(created.id);
    await expect(
      createProviderWebhookEndpoint(db, {
        workspaceId: WS,
        actorUserId: USER,
        provider: 'calcom',
        signingSecret: `${SECRET}-different`,
        endpointId
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createProviderWebhookEndpoint(db, {
        workspaceId: OTHER,
        actorUserId: OTHER_USER,
        provider: 'calcom',
        signingSecret: SECRET,
        endpointId
      })
    ).rejects.toBeInstanceOf(ProviderWebhookError);
    expect((await getProviderWebhookEndpointById(db, endpointId))?.workspaceId).toBe(WS);
    await expect(
      createProviderWebhookEndpoint(db, {
        workspaceId: WS,
        actorUserId: USER,
        provider: 'calcom',
        signingSecret: SECRET,
        endpointId: 'pwh_not-valid'
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to store a secret without secret custody', async () => {
    const saved = process.env.TREVRA_SECRETS_KEY;
    delete process.env.TREVRA_SECRETS_KEY;
    try {
      await expect(
        createProviderWebhookEndpoint(db, {
          workspaceId: WS,
          actorUserId: USER,
          provider: 'calcom',
          signingSecret: SECRET
        })
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      process.env.TREVRA_SECRETS_KEY = saved;
    }
  });

  // Keep last: it re-seals every endpoint secret under a new deployment key.
  it('includes webhook signing secrets in key-rotation custody', async () => {
    const oldKey = process.env.TREVRA_SECRETS_KEY!;
    const nextKey = randomBytes(32).toString('base64');
    const env = {
      ...process.env,
      TREVRA_SECRETS_KEY: nextKey,
      TREVRA_SECRETS_KEY_PREVIOUS: oldKey
    };
    const before = await secretsCustodyReport(db, env, { workspaceId: WS });
    expect(before.outstanding.some((row) => row.store === 'provider_webhook_endpoints')).toBe(true);
    const resealed = await resealSecrets(db, { env, workspaceId: WS });
    expect(resealed.resealed).toBeGreaterThan(0);
    expect((await secretsCustodyReport(db, env, { workspaceId: WS })).complete).toBe(true);
    process.env.TREVRA_SECRETS_KEY = nextKey;
    try {
      const delivered = await deliver(endpoint.id, { id: 'evt_after_rotation', type: 'ok' });
      expect(delivered.status).toBe(200);
    } finally {
      process.env.TREVRA_SECRETS_KEY = oldKey;
    }
  });
});
