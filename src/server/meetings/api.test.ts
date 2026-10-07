import { createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let signUpSeq = 0;
const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@meetings-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'meetings-api-pass-1', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerAndMember() {
  const owner = await signUp('meetings-owner');
  const member = await signUp('meetings-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  return { owner, member };
}

async function draftCalcom(agent: ReturnType<typeof request.agent>): Promise<string> {
  const draft = await agent
    .post('/api/setup/webhooks/draft')
    .send({ provider: 'calcom' })
    .expect(200);
  return draft.body.endpointId as string;
}

beforeAll(async () => {
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterAll(async () => {
  if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  await db?.close();
  await closeAuthDatabase();
});

describe('meetings setup API', () => {
  it('requires a session and keeps every write owner-only', async () => {
    await request(app).get('/api/setup/meetings').expect(401);
    const { owner, member } = await ownerAndMember();
    await member.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: 'https://cal.com/member/intro' })
      .expect(403);
    await member.agent
      .post('/api/setup/webhooks')
      .send({ provider: 'calcom', endpointId: `pwh_${'a'.repeat(24)}` })
      .expect(403);
    const initial = await owner.agent.get('/api/setup/meetings').expect(200);
    expect(initial.body).toEqual({
      bookingUrl: null,
      secretsConfigured: true,
      googleCalendar: { connected: false, status: null, lastSyncedAt: null, lastError: null },
      calcomConnected: false
    });
  });

  it('stores an https booking link, refuses anything else, and clears it', async () => {
    const { owner, member } = await ownerAndMember();
    const refused = await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: 'http://cal.com/founder/intro' })
      .expect(400);
    expect(refused.body.error).toMatch(/https:\/\//);
    const control = await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: 'https://cal.com/a\u0007b' })
      .expect(400);
    expect(control.body.error).toMatch(/control characters/);
    await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: '  https://cal.com/founder/intro ' })
      .expect(200, { bookingUrl: 'https://cal.com/founder/intro' });
    expect((await member.agent.get('/api/setup/meetings').expect(200)).body.bookingUrl).toBe(
      'https://cal.com/founder/intro'
    );
    await owner.agent
      .put('/api/setup/meetings/booking-link')
      .send({ bookingUrl: null })
      .expect(200, { bookingUrl: null });
    expect((await member.agent.get('/api/setup/meetings').expect(200)).body.bookingUrl).toBeNull();
  });

  it('connects Cal.com through the webhook routes with a secret Trevra shows once', async () => {
    const { owner, member } = await ownerAndMember();
    const endpointId = await draftCalcom(owner.agent);
    const created = await owner.agent
      .post('/api/setup/webhooks')
      .send({ provider: 'calcom', endpointId })
      .expect(201);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.endpoint).toMatchObject({
      id: endpointId,
      provider: 'calcom',
      status: 'active',
      path: `/api/hooks/v1/calcom/${endpointId}`,
      lastSeenAt: null,
      acceptedCount: 0,
      rejectedCount: 0
    });

    // The secret it returned is the one sealed for the endpoint.
    const raw = JSON.stringify({
      triggerEvent: 'MEETING_STARTED',
      createdAt: '2026-10-07T09:00:00.000Z'
    });
    const delivered = await request(app)
      .post(`/api/hooks/v1/calcom/${endpointId}`)
      .set('Content-Type', 'application/json')
      .set('X-Cal-Signature-256', createHmac('sha256', secret).update(raw).digest('hex'))
      .send(raw);
    expect(delivered.status).toBe(200);

    const again = await owner.agent
      .post('/api/setup/webhooks')
      .send({ provider: 'calcom', endpointId })
      .expect(409);
    expect(again.body.error).toMatch(/shown once/);
    expect(JSON.stringify(again.body)).not.toContain(secret);

    const listed = await owner.agent.get('/api/setup/webhooks').expect(200);
    expect(listed.body.endpoints).toEqual([
      expect.objectContaining({ id: endpointId, provider: 'calcom', acceptedCount: 1 })
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    const seen = await member.agent.get('/api/setup/meetings').expect(200);
    expect(seen.body.calcomConnected).toBe(true);
    expect(JSON.stringify(seen.body)).not.toContain(endpointId);
    expect(JSON.stringify(seen.body)).not.toMatch(/pwh_|\/api\/hooks/);
    expect(JSON.stringify(seen.body)).not.toContain(secret);

    const paused = await owner.agent
      .patch(`/api/setup/webhooks/${endpointId}/status`)
      .send({ status: 'disabled' })
      .expect(200);
    expect(paused.body.endpoint.status).toBe('disabled');
    expect((await member.agent.get('/api/setup/meetings').expect(200)).body.calcomConnected).toBe(
      false
    );
    await owner.agent
      .patch(`/api/setup/webhooks/pwh_${'0'.repeat(24)}/status`)
      .send({ status: 'disabled' })
      .expect(404);

    await owner.agent.delete(`/api/setup/webhooks/${endpointId}`).expect(204);
    expect((await owner.agent.get('/api/setup/webhooks').expect(200)).body.endpoints).toEqual([]);
  });

  it('generates a secret only for providers whose secret Trevra issues', async () => {
    const { owner } = await ownerAndMember();
    const stripe = await owner.agent
      .post('/api/setup/webhooks/draft')
      .send({ provider: 'stripe' })
      .expect(200);
    const refused = await owner.agent
      .post('/api/setup/webhooks')
      .send({ provider: 'stripe', endpointId: stripe.body.endpointId })
      .expect(400);
    expect(refused.body.error).toMatch(/signing secret/i);
    expect(refused.body).not.toHaveProperty('secret');
    expect((await owner.agent.get('/api/setup/webhooks').expect(200)).body.endpoints).toEqual([]);
  });

  it('refuses a short pasted Cal.com secret and keeps a strong one unrevealed', async () => {
    const { owner } = await ownerAndMember();
    const endpointId = await draftCalcom(owner.agent);
    const short = 'x'.repeat(31);
    const refused = await owner.agent
      .post('/api/setup/webhooks')
      .send({ provider: 'calcom', endpointId, signingSecret: short })
      .expect(400);
    expect(refused.body.error).toMatch(/32 characters/);
    expect(JSON.stringify(refused.body)).not.toContain(short);
    const strong = randomBytes(24).toString('base64url');
    const created = await owner.agent
      .post('/api/setup/webhooks')
      .send({ provider: 'calcom', endpointId, signingSecret: strong })
      .expect(201);
    expect(created.body.endpoint).toMatchObject({ id: endpointId, provider: 'calcom' });
    expect(created.body).not.toHaveProperty('secret');
    expect(JSON.stringify(created.body)).not.toContain(strong);
  });

  it('says so when the server cannot keep a signing secret', async () => {
    const { owner } = await ownerAndMember();
    const endpointId = await draftCalcom(owner.agent);
    const key = process.env.TREVRA_SECRETS_KEY;
    delete process.env.TREVRA_SECRETS_KEY;
    try {
      const refused = await owner.agent
        .post('/api/setup/webhooks')
        .send({ provider: 'calcom', endpointId })
        .expect(409);
      expect(refused.body.error).toMatch(/TREVRA_SECRETS_KEY/);
      expect(refused.body).not.toHaveProperty('secret');
      expect(
        (await owner.agent.get('/api/setup/meetings').expect(200)).body.secretsConfigured
      ).toBe(false);
    } finally {
      process.env.TREVRA_SECRETS_KEY = key;
    }
    expect((await owner.agent.get('/api/setup/webhooks').expect(200)).body.endpoints).toEqual([]);
  });

  it('reports the Google Calendar connection as it is, including its last error', async () => {
    const { owner } = await ownerAndMember();
    const workspaceId = owner.auth.workspaceId;
    const now = new Date().toISOString();
    const lastError = "1 record from 'GoogleCalendarEvent' could not be read and was not stored.";
    await db
      .prepare(
        'INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_synced_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        `conn_gcal_${workspaceId}`,
        workspaceId,
        'google-calendar',
        'trevra-google-calendar',
        `gcal-${workspaceId}`,
        'Founder calendar',
        'connected',
        0,
        now,
        lastError,
        now,
        now
      );
    const body = (await owner.agent.get('/api/setup/meetings').expect(200)).body;
    expect(body.googleCalendar).toEqual({
      connected: true,
      status: 'connected',
      lastSyncedAt: now,
      lastError
    });
  });
});
