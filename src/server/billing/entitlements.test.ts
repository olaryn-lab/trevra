import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { getBillingClient, resetBillingClientForTests } from '../billing-client.js';
import {
  BILLING_GRACE_MS,
  EntitlementDeniedError,
  accountBlock,
  applyDecision,
  billingEnforcementMode,
  can,
  loadEntitlements,
  type BillingEnforcementMode,
  type EntitlementView,
  type StoredBillingSnapshot
} from './entitlements.js';
import { FakeBilling } from './testing.js';

const A = 'ws_billing_ent_a';
const B = 'ws_billing_ent_b';
const NOW = new Date('2026-10-31T12:00:00.000Z');
let db: Db;

function snapshot(
  patch: Partial<StoredBillingSnapshot['subscription']> = {},
  features = {}
): StoredBillingSnapshot {
  return {
    customer: { plan_code: 'growth_monthly_usd', currency: 'USD', has_payment_profile: true },
    subscription: { status: 'active', plan_code: 'growth_monthly_usd', ...patch },
    credits: { balance: 10, usage: 0, available: 10, period_start: null, period_end: null },
    entitlements: { features }
  };
}

function metered(
  snap: StoredBillingSnapshot,
  fetchedAt = NOW,
  now = NOW,
  enforcement: BillingEnforcementMode = 'enforce'
): EntitlementView {
  const graceEndsAt = new Date(fetchedAt.getTime() + BILLING_GRACE_MS);
  return {
    mode: 'metered',
    snapshot: snap,
    fetchedAt,
    stale: false,
    withinGrace: now <= graceEndsAt,
    graceEndsAt,
    now,
    enforcement
  };
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
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const ws of [A, B]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(ws, ws, NOW.toISOString());
  }
});

afterEach(async () => {
  resetBillingClientForTests();
  await db.close();
});

describe('can()', () => {
  it('allows exactly at the limit and refuses limit + 1', () => {
    const view = metered(snapshot({}, { campaigns: { limit: 3 } }));
    expect(can(view, 'campaigns', 3)).toMatchObject({ allowed: true, limit: 3 });
    expect(can(view, 'campaigns', 4)).toMatchObject({
      allowed: false,
      code: 'limit_reached',
      limit: 3
    });
  });

  it('treats a present {} capability as unlimited and an absent one as not included', () => {
    const view = metered(snapshot({}, { campaigns: {} }));
    expect(can(view, 'campaigns', 10_000)).toMatchObject({ allowed: true, limit: null });
    expect(can(view, 'outreach_prepare', 1)).toMatchObject({
      allowed: false,
      code: 'not_included'
    });
    // Without the team capability the owner alone fits.
    expect(can(view, 'team', 1)).toMatchObject({ allowed: true, limit: 1 });
    expect(can(view, 'team', 2)).toMatchObject({ allowed: false, code: 'limit_reached' });
  });

  it('checks credits against the available balance, at and past the boundary', () => {
    const view = metered(snapshot());
    expect(can(view, 'credits', 10).allowed).toBe(true);
    expect(can(view, 'credits', 11)).toMatchObject({
      allowed: false,
      code: 'insufficient_credits'
    });
  });

  it('blocks expansion while payment needs attention', () => {
    const view = metered(snapshot({ status: 'past_due' }, { campaigns: {} }));
    expect(can(view, 'campaigns', 1)).toMatchObject({ allowed: false, code: 'payment_required' });
    expect(accountBlock(view)?.code).toBe('payment_required');
  });

  it('is permissive when Billing is unconfigured (unmetered), for every key and quantity', () => {
    const view: EntitlementView = { mode: 'unmetered' };
    for (const key of ['campaigns', 'outreach_prepare', 'team', 'credits'] as const)
      expect(can(view, key, 1_000_000).allowed).toBe(true);
    expect(accountBlock(view)).toBeNull();
  });

  it('blocks expansion once a trial has ended, and allows it while the trial runs', () => {
    const running = metered(
      snapshot(
        { status: 'trialing', current_period_end: '2026-11-05T00:00:00.000Z' },
        { campaigns: {} }
      )
    );
    expect(can(running, 'campaigns', 1).allowed).toBe(true);
    const ended = metered(
      snapshot(
        { status: 'trialing', current_period_end: '2026-10-30T00:00:00.000Z' },
        { campaigns: {} }
      )
    );
    const decision = can(ended, 'campaigns', 1);
    expect(decision).toMatchObject({ allowed: false, code: 'trial_expired' });
    expect(decision.allowed ? '' : decision.reason).toMatch(/data and running work are kept/);
  });
});

describe('rollout mode (TREVRA_BILLING_ENFORCEMENT)', () => {
  it('defaults to observe when unset or invalid', () => {
    expect(billingEnforcementMode({})).toBe('observe');
    expect(billingEnforcementMode({ TREVRA_BILLING_ENFORCEMENT: '' })).toBe('observe');
    expect(billingEnforcementMode({ TREVRA_BILLING_ENFORCEMENT: 'enforced' })).toBe('observe');
    expect(billingEnforcementMode({ TREVRA_BILLING_ENFORCEMENT: 'true' })).toBe('observe');
    expect(billingEnforcementMode({ TREVRA_BILLING_ENFORCEMENT: 'observe' })).toBe('observe');
    expect(billingEnforcementMode({ TREVRA_BILLING_ENFORCEMENT: ' Enforce ' })).toBe('enforce');
    expect(billingEnforcementMode({ TREVRA_BILLING_ENFORCEMENT: 'off' })).toBe('off');
  });

  it('observe records one would-deny per workspace, entitlement and hour, and never throws', async () => {
    const view = metered(snapshot({}, { campaigns: { limit: 1 } }), NOW, NOW, 'observe');
    const denied = can(view, 'campaigns', 2);
    await applyDecision(db, view, A, denied, 1);
    await applyDecision(db, view, A, can(view, 'campaigns', 3), 2);
    await applyDecision(db, view, A, can(view, 'credits', 50), null);
    await applyDecision(db, view, B, denied, 1);
    expect(await wouldDenyEvents(A)).toEqual([
      { entitlement: 'campaigns', reason: 'limit_reached', limit: 1, used: 1, requested: 2 },
      {
        entitlement: 'credits',
        reason: 'insufficient_credits',
        limit: 10,
        used: null,
        requested: 50
      }
    ]);
    const nextHour = new Date(NOW.getTime() + 60 * 60_000);
    const later = metered(snapshot({}, { campaigns: { limit: 1 } }), nextHour, nextHour, 'observe');
    await applyDecision(db, later, A, can(later, 'campaigns', 2), 1);
    expect(await wouldDenyEvents(A)).toHaveLength(3);
    expect(await wouldDenyEvents(B)).toHaveLength(1);
    // Allowed decisions record nothing.
    await applyDecision(db, view, A, can(view, 'campaigns', 1), 0);
    expect(await wouldDenyEvents(A)).toHaveLength(3);
  });

  it('enforce throws without recording; off neither throws nor records', async () => {
    const enforce = metered(snapshot({}, { campaigns: { limit: 1 } }));
    await expect(
      applyDecision(db, enforce, A, can(enforce, 'campaigns', 2), 1)
    ).rejects.toBeInstanceOf(EntitlementDeniedError);
    const off = metered(snapshot({}, { campaigns: { limit: 1 } }), NOW, NOW, 'off');
    await applyDecision(db, off, A, can(off, 'campaigns', 2), 1);
    expect(await wouldDenyEvents(A)).toEqual([]);
  });

  it('off answers write-path checks unmetered without asking Billing; reads still load', async () => {
    const fake = new FakeBilling({
      planCode: 'growth_monthly_usd',
      status: 'active',
      features: {},
      available: 0,
      usage: 0,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledPlanCode: null
    });
    expect(await loadEntitlements(db, A, { client: fake, now: NOW, enforcement: 'off' })).toEqual({
      mode: 'unmetered'
    });
    expect(fake.calls).toHaveLength(0);
    const read = await loadEntitlements(db, A, {
      client: fake,
      now: NOW,
      enforcement: 'off',
      purpose: 'read'
    });
    expect(read).toMatchObject({ mode: 'metered', enforcement: 'off' });
    expect(
      await loadEntitlements(db, A, { client: fake, now: NOW, enforcement: 'observe' })
    ).toMatchObject({ mode: 'metered', enforcement: 'observe' });
  });
});

describe('loadEntitlements', () => {
  it('is unmetered when no Billing client is configured', async () => {
    resetBillingClientForTests();
    expect(getBillingClient({})).toBeNull();
    await expect(loadEntitlements(db, A, { client: null, now: NOW })).resolves.toEqual({
      mode: 'unmetered'
    });
    const rows = await db
      .prepare('SELECT COUNT(*)::int AS total FROM billing_workspace_state WHERE workspace_id=?')
      .get<{ total: number }>(A);
    expect(rows?.total).toBe(0);
  });

  it('caches the snapshot in Postgres without Stripe or invoice identifiers and reuses it while fresh', async () => {
    const fake = new FakeBilling({
      planCode: 'growth_monthly_usd',
      status: 'active',
      features: { campaigns: {} },
      available: 50,
      usage: 0,
      periodEnd: '2026-11-30T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      scheduledPlanCode: null
    });
    const view = await loadEntitlements(db, A, { client: fake, now: NOW });
    expect(view).toMatchObject({ mode: 'metered', stale: false, withinGrace: true });
    const stored = await db
      .prepare(
        'SELECT snapshot_json::text AS json FROM billing_workspace_state WHERE workspace_id=?'
      )
      .get<{ json: string }>(A);
    expect(stored?.json).not.toMatch(/in_secret|sub_|cus_stripe|billing@example/);
    await loadEntitlements(db, A, { client: fake, now: new Date(NOW.getTime() + 30_000) });
    expect(fake.calls.filter((call) => call.method === 'workspaceSnapshot')).toHaveLength(1);
  });

  it('serves the cached snapshot inside the 72h grace window when Billing is unreachable, and blocks only expansion after it', async () => {
    const fake = new FakeBilling({
      planCode: 'growth_monthly_usd',
      status: 'active',
      features: { campaigns: { limit: 5 } },
      available: 50,
      usage: 0,
      periodEnd: '2026-11-30T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      scheduledPlanCode: null
    });
    await loadEntitlements(db, A, { client: fake, now: NOW });
    fake.unreachable = true;

    const within = await loadEntitlements(db, A, {
      client: fake,
      now: new Date(NOW.getTime() + BILLING_GRACE_MS - 60_000)
    });
    expect(within).toMatchObject({ mode: 'metered', stale: true, withinGrace: true });
    expect(can(within, 'campaigns', 5).allowed).toBe(true);
    expect(can(within, 'campaigns', 6).allowed).toBe(false);

    const past = await loadEntitlements(db, A, {
      client: fake,
      now: new Date(NOW.getTime() + BILLING_GRACE_MS + 60_000)
    });
    expect(past).toMatchObject({ mode: 'metered', stale: true, withinGrace: false });
    const decision = can(past, 'campaigns', 1);
    expect(decision).toMatchObject({ allowed: false, code: 'billing_unavailable' });
    expect(decision.allowed ? '' : decision.reason).toMatch(/Existing work keeps running/);
    // The snapshot itself is kept: reads still have something to show.
    expect(past.mode === 'metered' && past.snapshot?.subscription.plan_code).toBe(
      'growth_monthly_usd'
    );

    const state = await db
      .prepare('SELECT last_error FROM billing_workspace_state WHERE workspace_id=?')
      .get<{ last_error: string }>(A);
    expect(state?.last_error).toBe('Billing request failed (503)');
  });

  it('blocks expansion when Billing has never answered for the workspace', async () => {
    const fake = new FakeBilling({
      planCode: null,
      status: 'none',
      features: {},
      available: 0,
      usage: 0,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledPlanCode: null
    });
    fake.unreachable = true;
    const view = await loadEntitlements(db, A, { client: fake, now: NOW });
    expect(can(view, 'campaigns', 1)).toMatchObject({
      allowed: false,
      code: 'billing_unavailable'
    });
  });

  it('keeps each workspace on its own snapshot', async () => {
    const fake = new FakeBilling({
      planCode: 'growth_monthly_usd',
      status: 'active',
      features: { campaigns: {} },
      available: 50,
      usage: 0,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledPlanCode: null
    });
    fake.set(B, { status: 'past_due' });
    const a = await loadEntitlements(db, A, { client: fake, now: NOW });
    const b = await loadEntitlements(db, B, { client: fake, now: NOW });
    expect(can(a, 'campaigns', 1).allowed).toBe(true);
    expect(can(b, 'campaigns', 1)).toMatchObject({ allowed: false, code: 'payment_required' });
    expect(fake.calls.map((call) => call.workspaceId)).toEqual([A, B]);
  });
});
