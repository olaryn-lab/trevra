import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE_ID = 'ws_webhook_api';
const USER_ID = 'usr_webhook_api';
const SECRET = `whsec_${randomBytes(24).toString('hex')}`;

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Webhook API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'webhook-api@trevra.test', 'Webhook API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER_ID,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function owner() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

let signUpSeq = 0;
async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@webhook-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
  };
  return { agent, userId: response.body.user.id as string, auth };
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  session = await seedSession();
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
  await closeAuthDatabase();
});

describe('/api/setup/webhooks', () => {
  it('lets the owner draft, connect, pause and remove a Stripe endpoint', async () => {
    const empty = await owner().get('/api/setup/webhooks').expect(200);
    expect(empty.body).toMatchObject({ endpoints: [], secretsConfigured: true });
    expect(empty.body.providers).toContain('stripe');

    const draft = await owner()
      .post('/api/setup/webhooks/draft')
      .send({ provider: 'stripe' })
      .expect(200);
    expect(draft.body.endpointId).toMatch(/^pwh_[a-f0-9]{24}$/);
    expect(draft.body.path).toBe(`/api/hooks/v1/stripe/${draft.body.endpointId}`);

    const wrong = await owner()
      .post('/api/setup/webhooks')
      .send({
        provider: 'stripe',
        endpointId: draft.body.endpointId,
        signingSecret: 'sk_live_wrong'
      })
      .expect(400);
    expect(JSON.stringify(wrong.body)).not.toContain('sk_live_wrong');

    const created = await owner()
      .post('/api/setup/webhooks')
      .send({ provider: 'stripe', endpointId: draft.body.endpointId, signingSecret: SECRET })
      .expect(201);
    expect(created.body.endpoint).toMatchObject({
      id: draft.body.endpointId,
      provider: 'stripe',
      status: 'active',
      path: draft.body.path
    });
    expect(JSON.stringify(created.body)).not.toContain(SECRET);
    expect(JSON.stringify(created.body)).not.toMatch(/secret/i);
    const repeated = await owner()
      .post('/api/setup/webhooks')
      .send({ provider: 'stripe', endpointId: draft.body.endpointId, signingSecret: SECRET })
      .expect(201);
    expect(repeated.body.endpoint.id).toBe(draft.body.endpointId);
    expect(JSON.stringify(repeated.body)).not.toContain(SECRET);

    const paused = await owner()
      .patch(`/api/setup/webhooks/${draft.body.endpointId}/status`)
      .send({ status: 'disabled' })
      .expect(200);
    expect(paused.body.endpoint.status).toBe('disabled');
    expect(JSON.stringify(paused.body)).not.toContain(SECRET);
    const listed = await owner().get('/api/setup/webhooks').expect(200);
    expect(listed.body.endpoints).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);
    expect(JSON.stringify(listed.body)).not.toMatch(/ciphertext|secret_|auth_tag/i);

    await owner().delete(`/api/setup/webhooks/${draft.body.endpointId}`).expect(204);
    await owner().delete(`/api/setup/webhooks/${draft.body.endpointId}`).expect(204);
    await owner()
      .patch(`/api/setup/webhooks/${draft.body.endpointId}/status`)
      .send({ status: 'active' })
      .expect(404);
    expect((await owner().get('/api/setup/webhooks').expect(200)).body.endpoints).toEqual([]);
  });

  it("never lets another workspace's owner pause or remove this workspace's endpoint", async () => {
    const draft = await owner()
      .post('/api/setup/webhooks/draft')
      .send({ provider: 'stripe' })
      .expect(200);
    const endpointId = draft.body.endpointId as string;
    await owner()
      .post('/api/setup/webhooks')
      .send({ provider: 'stripe', endpointId, signingSecret: SECRET })
      .expect(201);

    const outsider = await signUp('webhook-outsider');
    // An owner of their own workspace, so a refusal below is scoping, not role.
    expect((await outsider.agent.get('/api/setup/webhooks').expect(200)).body.endpoints).toEqual(
      []
    );
    await outsider.agent
      .patch(`/api/setup/webhooks/${endpointId}/status`)
      .send({ status: 'disabled' })
      .expect(404);
    await outsider.agent.delete(`/api/setup/webhooks/${endpointId}`).expect(204);

    const listed = await owner().get('/api/setup/webhooks').expect(200);
    expect(listed.body.endpoints).toEqual([
      expect.objectContaining({ id: endpointId, status: 'active' })
    ]);
    await owner().delete(`/api/setup/webhooks/${endpointId}`).expect(204);
  });

  it('refuses every webhook management route to a non-owner member', async () => {
    const ownerUser = await signUp('webhook-owner');
    const member = await signUp('webhook-member');
    await betterAuth.api.addMember({
      body: {
        userId: member.userId,
        organizationId: ownerUser.auth.workspaceId,
        role: 'member'
      }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerUser.auth.workspaceId })
      .expect(200);
    await member.agent.get('/api/setup/webhooks').expect(403);
    await member.agent.post('/api/setup/webhooks/draft').send({ provider: 'stripe' }).expect(403);
    await member.agent
      .post('/api/setup/webhooks')
      .send({
        provider: 'stripe',
        endpointId: `pwh_${'a'.repeat(24)}`,
        signingSecret: SECRET
      })
      .expect(403);
    await member.agent
      .patch(`/api/setup/webhooks/pwh_${'a'.repeat(24)}/status`)
      .send({ status: 'disabled' })
      .expect(403);
    await member.agent.delete(`/api/setup/webhooks/pwh_${'a'.repeat(24)}`).expect(403);
  });
});

describe('/api/events', () => {
  it('refuses a meeting record, whatever origin it claims', async () => {
    const previous = process.env.INGEST_API_KEY;
    process.env.INGEST_API_KEY = 'test-only-ingest-key';
    try {
      const meeting = {
        kind: 'meeting',
        id: 'evt-api',
        personEmail: 'nia@prospect.example',
        status: 'scheduled',
        origin: 'booking',
        startAt: '2026-08-22T09:00:00Z',
        endAt: '2026-08-22T09:30:00Z'
      };
      const refused = await owner()
        .post('/api/events')
        .set('x-trevra-ingest-key', 'test-only-ingest-key')
        .send({ provider: 'calcom', record: meeting })
        .expect(400);
      expect(refused.body.error).toMatch(/meeting/i);
      const count = await db
        .prepare('SELECT COUNT(*)::int AS n FROM meetings WHERE workspace_id=?')
        .get<{ n: number }>(WORKSPACE_ID);
      expect(Number(count?.n)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.INGEST_API_KEY;
      else process.env.INGEST_API_KEY = previous;
    }
  });
});
