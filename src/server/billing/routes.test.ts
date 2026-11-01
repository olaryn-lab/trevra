import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { setBillingClientForTests } from '../billing-client.js';
import { upsertSeat } from '../linkedin/seats.js';
import { billingIdempotencyKey } from './routes.js';
import { FakeBilling, fakePlan, type FakeWorkspaceBilling } from './testing.js';

let db: Db;
let app: Express;
let fake: FakeBilling;
const A = 'ws_billing_routes_a';
const B = 'ws_billing_routes_b';
const START = new Date('2026-10-01T09:00:00.000Z');
let tokenA = '';
let tokenB = '';

const DEFAULTS: FakeWorkspaceBilling = {
  planCode: 'growth_monthly_usd',
  status: 'active',
  features: { campaigns: { limit: 2 }, outreach_prepare: { limit: 2 }, team: {} },
  available: 100,
  usage: 0,
  periodEnd: '2026-11-30T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  scheduledPlanCode: null
};

async function session(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, workspaceId, START.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(userId, workspaceId, `${userId}@trevra.test`, workspaceId, START.toISOString());
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      START.toISOString()
    );
  return token;
}

function as(token: string) {
  const cookie = `trevra_session=${token}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie)
  };
}

async function createCampaign(token: string, name: string): Promise<string> {
  const list = (
    await as(token)
      .post('/api/linkedin/manager/lead-lists')
      .send({ name: `${name} list`, sourceKind: 'csv' })
      .expect(201)
  ).body.list;
  const workflow = (
    await as(token)
      .post('/api/linkedin/manager/workflows')
      .send({
        name: `${name} flow`,
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      })
      .expect(201)
  ).body.workflow;
  return (
    await as(token)
      .post('/api/linkedin/manager/campaigns')
      .send({ name, leadListId: list.id, workflowId: workflow.id })
      .expect(201)
  ).body.campaign.id as string;
}

async function campaignStatuses(workspaceId: string): Promise<string[]> {
  const rows = await db
    .prepare('SELECT status FROM linkedin_campaigns WHERE workspace_id=? ORDER BY name')
    .all<{ status: string }>(workspaceId);
  return rows.map((row) => row.status);
}

async function clear(workspaceId: string) {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

const ENFORCEMENT_ENV = 'TREVRA_BILLING_ENFORCEMENT';
const previousEnforcement = process.env[ENFORCEMENT_ENV];

function setEnforcement(value: string | undefined) {
  if (value === undefined) delete process.env[ENFORCEMENT_ENV];
  else process.env[ENFORCEMENT_ENV] = value;
}

async function wouldDenyEvents(workspaceId: string) {
  const rows = await db
    .prepare(
      `SELECT payload_json FROM domain_events
       WHERE workspace_id=? AND event_type='billing.entitlement.would_deny' ORDER BY position`
    )
    .all<{ payload_json: Record<string, unknown> }>(workspaceId);
  return rows.map((row) => row.payload_json);
}

beforeEach(async () => {
  // The blocking behaviour below is the `enforce` rollout mode; the
  // `enforcement rollout mode` block switches it explicitly.
  setEnforcement('enforce');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await clear(A);
  await clear(B);
  tokenA = await session(A);
  tokenB = await session(B);
  for (const ws of [A, B])
    await upsertSeat(db, ws, { label: `Owner ${ws}`, timezone: 'Europe/Zurich' }, START);
  fake = new FakeBilling(DEFAULTS);
  fake.catalog = [
    fakePlan('starter', 'monthly', { campaigns: { limit: 1 }, outreach_prepare: { limit: 1 } }),
    fakePlan('growth', 'monthly', DEFAULTS.features),
    fakePlan('growth', 'yearly', DEFAULTS.features)
  ];
  setBillingClientForTests(fake);
});

afterEach(async () => {
  setBillingClientForTests(null);
  setEnforcement(previousEnforcement);
  await db.close();
});

describe('campaign activation gate', () => {
  it('allows activation up to exactly the running-campaign limit and refuses limit + 1 with a 402', async () => {
    const ids = [];
    for (const name of ['c1', 'c2', 'c3']) ids.push(await createCampaign(tokenA, name));
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${ids[0]}/start`).send({}).expect(200);
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${ids[1]}/start`).send({}).expect(200);
    const refused = await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${ids[2]}/start`)
      .send({})
      .expect(402);
    expect(refused.body).toMatchObject({
      code: 'entitlement_denied',
      reason: 'limit_reached',
      entitlement: 'campaigns',
      limit: 2,
      used: 2,
      billingUrl: '/setup/billing'
    });
    expect(refused.body.error).toMatch(/Nothing was deleted/);
    expect(await campaignStatuses(A)).toEqual(['running', 'running', 'draft']);
    // Re-starting an already-running campaign is not an expansion.
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${ids[0]}/start`).send({}).expect(200);
  });

  it('lets exactly one of two concurrent activations at the limit win', async () => {
    fake.set(A, { features: { ...DEFAULTS.features, campaigns: { limit: 1 } } });
    const first = await createCampaign(tokenA, 'race-1');
    const second = await createCampaign(tokenA, 'race-2');
    const results = await Promise.all(
      [first, second].map((id) =>
        as(tokenA).post(`/api/linkedin/manager/campaigns/${id}/start`).send({})
      )
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 402]);
    expect((await campaignStatuses(A)).filter((status) => status === 'running')).toHaveLength(1);
  });

  it('blocks activation when credits are exhausted', async () => {
    fake.set(A, { available: 0 });
    const id = await createCampaign(tokenA, 'no-credits');
    const refused = await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${id}/start`)
      .send({})
      .expect(402);
    expect(refused.body.reason).toBe('insufficient_credits');
  });

  it('is permissive when Billing is not configured', async () => {
    setBillingClientForTests(null);
    const ids = [];
    for (const name of ['u1', 'u2', 'u3']) ids.push(await createCampaign(tokenA, name));
    for (const id of ids)
      await as(tokenA).post(`/api/linkedin/manager/campaigns/${id}/start`).send({}).expect(200);
    await as(tokenA)
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'extra-1', label: 'Extra 1', timezone: 'Europe/Zurich' })
      .expect(201);
    await as(tokenA)
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'extra-2', label: 'Extra 2', timezone: 'Europe/Zurich' })
      .expect(201);
    expect((await as(tokenA).get('/api/billing').expect(200)).body).toEqual({ enabled: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('treats resuming a paused campaign as running again: it retakes its own slot, not one taken meanwhile', async () => {
    fake.set(A, { features: { ...DEFAULTS.features, campaigns: { limit: 1 } } });
    const first = await createCampaign(tokenA, 'r1');
    const second = await createCampaign(tokenA, 'r2');
    const start = (id: string) =>
      as(tokenA).post(`/api/linkedin/manager/campaigns/${id}/start`).send({});
    const pause = (id: string) =>
      as(tokenA).post(`/api/linkedin/manager/campaigns/${id}/pause`).send({}).expect(200);
    await start(first).expect(200);
    await pause(first);
    // At the limit before the pause; resuming is running again, not a new activation.
    await start(first).expect(200);
    expect(await campaignStatuses(A)).toEqual(['running', 'draft']);
    await pause(first);
    // The freed slot went to another campaign, so resuming would exceed the running cap.
    await start(second).expect(200);
    const refused = await start(first).expect(402);
    expect(refused.body).toMatchObject({ entitlement: 'campaigns', limit: 1, used: 1 });
    expect(await campaignStatuses(A)).toEqual(['paused', 'running']);
  });

  it('blocks expansions after a trial ends while keeping campaigns and their data', async () => {
    const running = await createCampaign(tokenA, 't1');
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${running}/start`).send({}).expect(200);
    const draft = await createCampaign(tokenA, 't2');
    fake.set(A, { status: 'trialing', periodEnd: new Date(Date.now() - 3_600_000).toISOString() });
    // Expire the cache so the new state is read.
    await db
      .prepare(
        "UPDATE billing_workspace_state SET fetched_at=fetched_at - interval '2 minutes' WHERE workspace_id=?"
      )
      .run(A);
    const refused = await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${draft}/start`)
      .send({})
      .expect(402);
    expect(refused.body.reason).toBe('trial_expired');
    expect(await campaignStatuses(A)).toEqual(['running', 'draft']);
    const billing = (await as(tokenA).get('/api/billing').expect(200)).body;
    expect(billing.trial).toMatchObject({ active: false, expired: true });
    expect(billing.expansionBlock.code).toBe('trial_expired');
    // Reads keep working.
    await as(tokenA).get(`/api/linkedin/manager/campaigns/${running}`).expect(200);
  });
});

describe('downgrade over limits', () => {
  it('never deletes anything, blocks new expansion and reports which resources are over', async () => {
    const c1 = await createCampaign(tokenA, 'd1');
    const c2 = await createCampaign(tokenA, 'd2');
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${c1}/start`).send({}).expect(200);
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${c2}/start`).send({}).expect(200);
    await as(tokenA)
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'second', label: 'Second', timezone: 'Europe/Zurich', dailyInviteLimit: 10 })
      .expect(201);

    const preview = (
      await as(tokenA)
        .post('/api/billing/preview')
        .send({ planCode: 'starter_monthly_usd' })
        .expect(200)
    ).body;
    expect(preview.overLimit.map((line: { key: string }) => line.key).sort()).toEqual([
      'campaigns',
      'outreach_prepare'
    ]);

    // The downgrade lands (Billing now reports the starter capabilities).
    fake.set(A, {
      planCode: 'starter_monthly_usd',
      features: { campaigns: { limit: 1 }, outreach_prepare: { limit: 1 } }
    });
    await db
      .prepare(
        "UPDATE billing_workspace_state SET fetched_at=fetched_at - interval '2 minutes' WHERE workspace_id=?"
      )
      .run(A);

    const billing = (await as(tokenA).get('/api/billing').expect(200)).body;
    const over = billing.usage.filter((line: { over: boolean }) => line.over);
    expect(over.map((line: { key: string }) => line.key).sort()).toEqual([
      'campaigns',
      'outreach_prepare'
    ]);

    expect(await campaignStatuses(A)).toEqual(['running', 'running']);
    const seats = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_seats WHERE workspace_id=?')
      .get<{ total: number }>(A);
    expect(seats?.total).toBe(2);

    const c3 = await createCampaign(tokenA, 'd3');
    expect(
      (await as(tokenA).post(`/api/linkedin/manager/campaigns/${c3}/start`).send({}).expect(402))
        .body.entitlement
    ).toBe('campaigns');
    expect(
      (
        await as(tokenA)
          .post('/api/linkedin/manager/seats')
          .send({ seatKey: 'third', label: 'Third', timezone: 'Europe/Zurich' })
          .expect(402)
      ).body.entitlement
    ).toBe('outreach_prepare');
    // Raising an existing account's volume is an expansion too; lowering is not.
    await as(tokenA)
      .patch('/api/linkedin/manager/seats/second')
      .send({ dailyInviteLimit: 11 })
      .expect(402);
    await as(tokenA)
      .patch('/api/linkedin/manager/seats/second')
      .send({ dailyInviteLimit: 9 })
      .expect(200);
    // Pausing a running campaign is never blocked.
    await as(tokenA).post(`/api/linkedin/manager/campaigns/${c1}/pause`).send({}).expect(200);
  });
});

describe('lifecycle routes', () => {
  it('derive idempotency keys from workspace, target plan and nonce', async () => {
    const body = { planCode: 'starter_monthly_usd', nonce: 'nonce-0001' };
    await as(tokenA).post('/api/billing/change').send(body).expect(200);
    await as(tokenA).post('/api/billing/change').send(body).expect(200);
    await as(tokenB).post('/api/billing/change').send(body).expect(200);
    const keys = fake.calls
      .filter((call) => call.method === 'changePlan')
      .map((call) => [call.workspaceId, call.idempotencyKey]);
    expect(keys[0]).toEqual([
      A,
      billingIdempotencyKey(A, 'change', 'starter_monthly_usd', 'nonce-0001')
    ]);
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]?.[1]).not.toEqual(keys[0]?.[1]);
    expect(keys[2]?.[0]).toBe(B);

    await as(tokenA).post('/api/billing/cancel').send({ nonce: 'nonce-0002' }).expect(200);
    expect((await as(tokenA).get('/api/billing').expect(200)).body.renewal).toMatchObject({
      cancelAtPeriodEnd: true,
      endsOn: '2026-11-30',
      renewsOn: null
    });
    await as(tokenA).post('/api/billing/resume').send({ nonce: 'nonce-0003' }).expect(200);
    expect((await as(tokenA).get('/api/billing').expect(200)).body.renewal.cancelAtPeriodEnd).toBe(
      false
    );
    await as(tokenA).post('/api/billing/cancel').send({ nonce: 'x' }).expect(400);
  });

  it('are owner-only; members can read billing state but not change it', async () => {
    const email = (label: string) =>
      `${label}-${Date.now()}-${randomBytes(3).toString('hex')}@example.test`;
    const owner = request.agent(app);
    await owner
      .post('/api/auth/sign-up/email')
      .send({
        email: email('billing-owner'),
        password: 'correct horse battery',
        name: 'Billing Owner'
      })
      .expect(200);
    const workspaceId = (await owner.get('/api/auth/session').expect(200)).body.auth
      .workspaceId as string;
    const member = request.agent(app);
    const memberSignUp = await member
      .post('/api/auth/sign-up/email')
      .send({
        email: email('billing-member'),
        password: 'correct horse battery',
        name: 'Billing Member'
      })
      .expect(200);
    await betterAuth.api.addMember({
      body: { userId: memberSignUp.body.user.id, organizationId: workspaceId, role: 'member' }
    });
    await member
      .post('/api/auth/organization/set-active')
      .send({ organizationId: workspaceId })
      .expect(200);
    expect((await member.get('/api/auth/session').expect(200)).body.auth.role).toBe('member');

    const reads = (await member.get('/api/billing').expect(200)).body;
    expect(reads.canManage).toBe(false);
    for (const [path, body] of [
      ['/api/billing/checkout', { planCode: 'growth_monthly_usd', nonce: 'nonce-member' }],
      ['/api/billing/preview', { planCode: 'starter_monthly_usd' }],
      ['/api/billing/change', { planCode: 'starter_monthly_usd', nonce: 'nonce-member' }],
      ['/api/billing/cancel', { nonce: 'nonce-member' }],
      ['/api/billing/resume', { nonce: 'nonce-member' }]
    ] as const)
      await member.post(path).send(body).expect(403);
    expect(
      fake.calls.some(
        (call) => call.method === 'changePlan' || call.method === 'cancelSubscription'
      )
    ).toBe(false);

    expect((await owner.get('/api/billing').expect(200)).body.canManage).toBe(true);
    await owner.post('/api/billing/cancel').send({ nonce: 'nonce-owner' }).expect(200);
  });
});

describe('team limit', () => {
  it('counts members plus pending invitations and refuses the invite past the limit', async () => {
    const email = (label: string) =>
      `${label}-${Date.now()}-${randomBytes(3).toString('hex')}@example.test`;
    const owner = request.agent(app);
    await owner
      .post('/api/auth/sign-up/email')
      .send({ email: email('team-owner'), password: 'correct horse battery', name: 'Team Owner' })
      .expect(200);
    const workspaceId = (await owner.get('/api/auth/session').expect(200)).body.auth
      .workspaceId as string;
    fake.set(workspaceId, { features: { ...DEFAULTS.features, team: { limit: 2 } } });

    await owner
      .post('/api/team/members')
      .send({ email: email('first') })
      .expect(201);
    const refused = await owner
      .post('/api/team/members')
      .send({ email: email('second') })
      .expect(402);
    expect(refused.body).toMatchObject({ entitlement: 'team', limit: 2, used: 2 });
    // Better Auth's own endpoint is guarded by the organization hook.
    const direct = await owner
      .post('/api/auth/organization/invite-member')
      .send({ email: email('third'), role: 'member', organizationId: workspaceId });
    expect(direct.status).toBe(403);
  });
});

describe('enforcement rollout mode', () => {
  async function startAll(names: string[]) {
    const statuses = [];
    for (const name of names) {
      const id = await createCampaign(tokenA, name);
      statuses.push(
        (await as(tokenA).post(`/api/linkedin/manager/campaigns/${id}/start`).send({})).status
      );
    }
    return statuses;
  }

  it('observe (unset) never blocks at limit + 1 and records exactly one deduped would-deny event', async () => {
    setEnforcement(undefined);
    fake.set(A, { features: { ...DEFAULTS.features, campaigns: { limit: 1 } } });
    expect(await startAll(['o1', 'o2', 'o3'])).toEqual([200, 200, 200]);
    expect(await campaignStatuses(A)).toEqual(['running', 'running', 'running']);
    expect(await wouldDenyEvents(A)).toEqual([
      { entitlement: 'campaigns', reason: 'limit_reached', limit: 1, used: 1, requested: 2 }
    ]);
    // A seat past the limit is not blocked either; its own entitlement records once.
    await as(tokenA)
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'observe-2', label: 'Observe 2', timezone: 'Europe/Zurich' })
      .expect(201);
    await as(tokenA)
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'observe-3', label: 'Observe 3', timezone: 'Europe/Zurich' })
      .expect(201);
    expect((await wouldDenyEvents(A)).map((event) => event.entitlement)).toEqual([
      'campaigns',
      'outreach_prepare'
    ]);
    expect(await wouldDenyEvents(B)).toEqual([]);
    // Observing never reserves or settles credits.
    expect(
      fake.calls.some(
        (call) => call.method === 'reserveCredits' || call.method === 'settleReservation'
      )
    ).toBe(false);
    const billing = (await as(tokenA).get('/api/billing').expect(200)).body;
    expect(billing.enforcement).toBe('observe');
    expect(billing.usage.find((line: { key: string }) => line.key === 'campaigns')).toMatchObject({
      used: 3,
      limit: 1,
      over: true
    });
  });

  it('an invalid value means observe', async () => {
    setEnforcement('enforced');
    fake.set(A, { features: { ...DEFAULTS.features, campaigns: { limit: 1 } } });
    expect(await startAll(['v1', 'v2'])).toEqual([200, 200]);
    expect(await wouldDenyEvents(A)).toHaveLength(1);
    expect((await as(tokenA).get('/api/billing').expect(200)).body.enforcement).toBe('observe');
  });

  it('enforce blocks the same request observe lets through', async () => {
    fake.set(A, { features: { ...DEFAULTS.features, campaigns: { limit: 1 } } });
    expect(await startAll(['e1', 'e2'])).toEqual([200, 402]);
    expect(await wouldDenyEvents(A)).toEqual([]);
  });

  it('off skips the gate: nothing blocks, nothing is recorded and write paths never ask Billing', async () => {
    setEnforcement('off');
    fake.set(A, { features: { ...DEFAULTS.features, campaigns: { limit: 1 } } });
    expect(await startAll(['f1', 'f2'])).toEqual([200, 200]);
    expect(await wouldDenyEvents(A)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect((await as(tokenA).get('/api/billing').expect(200)).body.enforcement).toBe('off');
  });

  it('team invites follow the mode: observe records instead of refusing, on both invite paths', async () => {
    setEnforcement('observe');
    const email = (label: string) =>
      `${label}-${Date.now()}-${randomBytes(3).toString('hex')}@example.test`;
    const owner = request.agent(app);
    await owner
      .post('/api/auth/sign-up/email')
      .send({ email: email('obs-owner'), password: 'correct horse battery', name: 'Obs Owner' })
      .expect(200);
    const workspaceId = (await owner.get('/api/auth/session').expect(200)).body.auth
      .workspaceId as string;
    fake.set(workspaceId, { features: { ...DEFAULTS.features, team: { limit: 1 } } });
    await owner
      .post('/api/team/members')
      .send({ email: email('obs-first') })
      .expect(201);
    const direct = await owner
      .post('/api/auth/organization/invite-member')
      .send({ email: email('obs-second'), role: 'member', organizationId: workspaceId });
    expect(direct.status).toBe(200);
    const events = await wouldDenyEvents(workspaceId);
    expect(events).toEqual([
      { entitlement: 'team', reason: 'limit_reached', limit: 1, used: 1, requested: 2 }
    ]);
  });
});

describe('workspace isolation', () => {
  it('counts and caches each workspace separately', async () => {
    for (const name of ['i1', 'i2']) {
      const id = await createCampaign(tokenA, name);
      await as(tokenA).post(`/api/linkedin/manager/campaigns/${id}/start`).send({}).expect(200);
    }
    // A is at its limit; B is untouched and can still start.
    const b = await createCampaign(tokenB, 'b1');
    await as(tokenB).post(`/api/linkedin/manager/campaigns/${b}/start`).send({}).expect(200);
    const usageA = (await as(tokenA).get('/api/billing').expect(200)).body.usage;
    const usageB = (await as(tokenB).get('/api/billing').expect(200)).body.usage;
    expect(usageA.find((line: { key: string }) => line.key === 'campaigns').used).toBe(2);
    expect(usageB.find((line: { key: string }) => line.key === 'campaigns').used).toBe(1);
    const cached = await db
      .prepare(
        'SELECT workspace_id FROM billing_workspace_state WHERE workspace_id IN (?,?) ORDER BY workspace_id'
      )
      .all<{ workspace_id: string }>(A, B);
    expect(cached.map((row) => row.workspace_id)).toEqual([A, B]);
  });
});
