import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateAuthDatabase, closeAuthDatabase } from './auth-service.js';
import { createApp } from './app.js';
import { openDatabase, type Db } from './db.js';

// The create/update egress pre-flight resolves the host. No network in tests:
// every lookup answers with a single public address.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  return { ...actual, lookup, default: { ...actual, lookup } };
});
const WORKSPACE = 'ws_outbound_webhooks_api';
const USER = 'usr_outbound_webhooks_api';
let db: Db;
let session = '';
let originalHosts: string | undefined;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  originalHosts = process.env.TREVRA_OUTBOUND_WEBHOOK_HOSTS;
  process.env.TREVRA_OUTBOUND_WEBHOOK_HOSTS = 'hooks.partner.example';
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
    .run(WORKSPACE, 'Webhook notification API', now);
  await db
    .prepare(
      'INSERT INTO users(id,workspace_id,email,name,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING'
    )
    .run(USER, WORKSPACE, 'outbound-hook-api@trevra.test', 'Webhook API', now);
  session = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(
      createHash('sha256').update(session).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
});
afterAll(async () => {
  if (db) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db.close();
  }
  await closeAuthDatabase();
  if (originalHosts === undefined) delete process.env.TREVRA_OUTBOUND_WEBHOOK_HOSTS;
  else process.env.TREVRA_OUTBOUND_WEBHOOK_HOSTS = originalHosts;
});
function owner() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

describe('authenticated merchant outbound webhook routes', () => {
  it('requires session and owner, rejects unapproved hosts before persisting', async () => {
    await request(app).get('/api/outbound-webhooks').expect(401);
    await request(app)
      .post('/api/outbound-webhooks')
      .send({
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['linkedin_campaign.started']
      })
      .expect(401);
    await owner()
      .post('/api/outbound-webhooks')
      .send({
        url: 'http://127.0.0.1/notify',
        eventTypes: ['linkedin_campaign.started']
      })
      .expect(400);
    await owner()
      .post('/api/outbound-webhooks')
      .send({
        url: 'https://hooks.partner.example/notify',
        eventTypes: ['private.secret.changed']
      })
      .expect(400);
    expect((await owner().get('/api/outbound-webhooks').expect(200)).body.subscriptions).toEqual(
      []
    );
  });

  it('returns signing key on creation only, and supports workspace-scoped deactivation', async () => {
    const created = (
      await owner()
        .post('/api/outbound-webhooks')
        .send({
          url: 'https://hooks.partner.example/notify',
          eventTypes: ['linkedin_campaign.started', 'linkedin_campaign.stopped']
        })
        .expect(201)
    ).body;
    expect(created.signingSecret).toMatch(/^whsec_/);
    expect(created.subscription).toMatchObject({ workspaceId: WORKSPACE, active: true });
    expect(JSON.stringify(created.subscription)).not.toContain('whsec_');
    const listed = await owner().get('/api/outbound-webhooks').expect(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.subscriptions).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toMatch(/whsec_|ciphertext|auth_tag/);
    await owner().get(`/api/outbound-webhooks/${created.subscription.id}/deliveries`).expect(200);
    await owner().get('/api/outbound-webhooks/nonexistent/deliveries').expect(404);
    await owner().delete('/api/outbound-webhooks/nonexistent').expect(404);
    await owner().delete(`/api/outbound-webhooks/${created.subscription.id}`).expect(200);
    expect(
      (await owner().get('/api/outbound-webhooks').expect(200)).body.subscriptions[0].active
    ).toBe(false);
  });

  it('rotates the secret once, edits, reports health, and gates replay on state and cap', async () => {
    const created = (
      await owner()
        .post('/api/outbound-webhooks')
        .send({
          url: 'https://hooks.partner.example/rotate',
          eventTypes: ['linkedin_campaign.started']
        })
        .expect(201)
    ).body;
    const id = created.subscription.id as string;
    await request(app).post(`/api/outbound-webhooks/${id}/rotate-secret`).send({}).expect(401);
    const rotated = await owner()
      .post(`/api/outbound-webhooks/${id}/rotate-secret`)
      .send({ overlapHours: 24 })
      .expect(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(rotated.body.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated.body.signingSecret).not.toBe(created.signingSecret);
    expect(rotated.body.subscription.previousSecretExpiresAt).toBeTruthy();
    const listed = await owner().get('/api/outbound-webhooks').expect(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/whsec_|ciphertext|auth_tag/);
    await owner()
      .post(`/api/outbound-webhooks/${id}/rotate-secret`)
      .send({ overlapHours: 500 })
      .expect(400);
    await owner().post('/api/outbound-webhooks/owhs_missing/rotate-secret').send({}).expect(404);

    await owner()
      .patch(`/api/outbound-webhooks/${id}`)
      .send({ url: 'https://169.254.169.254/latest/meta-data' })
      .expect(400);
    await owner().patch(`/api/outbound-webhooks/${id}`).send({}).expect(400);
    const edited = await owner()
      .patch(`/api/outbound-webhooks/${id}`)
      .send({ eventTypes: ['linkedin_campaign.started', 'playbook.run.failed'] })
      .expect(200);
    expect(edited.body.subscription.eventTypes).toEqual([
      'linkedin_campaign.started',
      'playbook.run.failed'
    ]);

    const health = await owner().get(`/api/outbound-webhooks/${id}/health`).expect(200);
    expect(health.body).toEqual({
      stats: {
        last24h: { delivered: 0, failed: 0, pending: 0, dead: 0 },
        last7d: { delivered: 0, failed: 0, pending: 0, dead: 0 },
        consecutiveFailures: 0,
        lastFailureCode: null,
        lastFailureAt: null,
        lastSuccessAt: null
      },
      attempts: []
    });
    await owner().get('/api/outbound-webhooks/owhs_missing/health').expect(404);

    const tooMany = await owner()
      .post(`/api/outbound-webhooks/${id}/replay`)
      .send({ limit: 501 })
      .expect(400);
    expect(tooMany.body).toMatchObject({ code: 'replay_cap_exceeded' });
    expect(tooMany.body.error).toMatch(/between 1 and 500/);
    expect(
      (await owner().post(`/api/outbound-webhooks/${id}/replay`).send({}).expect(200)).body
    ).toEqual({ replayed: 0, deliveryIds: [] });
    await owner()
      .post(`/api/outbound-webhooks/${id}/deliveries/owhd_missing/replay`)
      .send({})
      .expect(404);

    await owner().patch(`/api/outbound-webhooks/${id}`).send({ active: false }).expect(200);
    const refused = await owner().post(`/api/outbound-webhooks/${id}/replay`).send({}).expect(409);
    expect(refused.body).toMatchObject({ code: 'subscription_inactive' });
    const enabled = await owner()
      .patch(`/api/outbound-webhooks/${id}`)
      .send({ active: true })
      .expect(200);
    expect(enabled.body.subscription).toMatchObject({ active: true, disabledReason: null });
    await owner().post('/api/outbound-webhooks/owhs_missing/replay').send({}).expect(404);
  });
});
