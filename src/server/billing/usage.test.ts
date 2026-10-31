import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { BillingServiceError } from '../billing-client.js';
import { loadEntitlements } from './entitlements.js';
import { runBillingMaintenance } from './maintenance.js';
import {
  enqueueBillableUsage,
  pruneBillingUsage,
  reportPendingUsage,
  usageEventId,
  usageReservationKey
} from './usage.js';
import { FakeBilling } from './testing.js';

const A = 'ws_billing_usage_a';
const B = 'ws_billing_usage_b';
const NOW = new Date('2026-10-31T12:00:00.000Z');
let db: Db;
let fake: FakeBilling;

async function action(
  workspaceId: string,
  id: string,
  patch: { status?: string; source?: string; at?: Date } = {}
) {
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,recorded_at,source)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      workspaceId,
      'owner',
      'invite',
      `target-${id}`,
      patch.status ?? 'sent',
      (patch.at ?? new Date(NOW.getTime() - 60_000)).toISOString(),
      patch.source ?? 'campaign'
    );
}

async function executed(workspaceId: string, id: string, at = new Date(NOW.getTime() - 60_000)) {
  await db
    .prepare(
      `INSERT INTO domain_events (id,workspace_id,stream_type,stream_id,stream_version,event_type,actor_type,occurred_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      workspaceId,
      'action',
      `stream-${id}`,
      1,
      'action.executed',
      'system',
      at.toISOString()
    );
}

async function outbox(workspaceId: string) {
  return db
    .prepare(
      `SELECT id,source_type,source_id,status,reservation_id,reservation_generation,attempts,last_error
       FROM billing_usage_outbox WHERE workspace_id=? ORDER BY source_type,source_id`
    )
    .all<{
      id: string;
      source_type: string;
      source_id: string;
      status: string;
      reservation_id: string | null;
      reservation_generation: number;
      attempts: number;
      last_error: string | null;
    }>(workspaceId);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const ws of [A, B]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(ws, ws, NOW.toISOString());
  }
  fake = new FakeBilling({
    planCode: 'growth_monthly_usd',
    status: 'active',
    features: { campaigns: {} },
    available: 100,
    usage: 0,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledPlanCode: null
  });
  // Only A is metered: it has a Billing snapshot, and metering started an hour ago.
  await loadEntitlements(db, A, { client: fake, now: NOW });
  await db
    .prepare('UPDATE billing_workspace_state SET metering_started_at=? WHERE workspace_id=?')
    .run(new Date(NOW.getTime() - 3_600_000).toISOString(), A);
});

afterEach(async () => {
  await db.close();
});

describe('enqueueBillableUsage', () => {
  it('derives deterministic ids that match usageEventId, and enqueues each billable row once', async () => {
    await action(A, 'act_sent');
    await action(A, 'act_manual', { source: 'manual' });
    await action(A, 'act_export', { source: 'export', status: 'exported' });
    await action(A, 'act_planned', { status: 'planned' });
    await action(A, 'act_before_metering', { at: new Date(NOW.getTime() - 2 * 3_600_000) });
    await executed(A, 'evt_exec');
    await action(B, 'act_unmetered');

    expect(await enqueueBillableUsage(db, { now: NOW })).toBe(2);
    expect(await enqueueBillableUsage(db, { now: NOW })).toBe(0);
    const rows = await outbox(A);
    expect(rows.map((row) => [row.source_type, row.source_id])).toEqual([
      ['domain_event', 'evt_exec'],
      ['linkedin_action', 'act_sent']
    ]);
    expect(rows[0]?.id).toBe(usageEventId(A, 'credits', 'domain_event', 'evt_exec'));
    expect(rows[1]?.id).toBe(usageEventId(A, 'credits', 'linkedin_action', 'act_sent'));
    expect(await outbox(B)).toEqual([]);
  });
});

describe('reportPendingUsage', () => {
  it('reserves and settles each event once; reruns report nothing new', async () => {
    await action(A, 'act_1');
    await action(A, 'act_2');
    await enqueueBillableUsage(db, { now: NOW });
    const first = await reportPendingUsage(db, { client: fake, now: NOW });
    expect(first).toMatchObject({ claimed: 2, reported: 2 });
    expect(fake.settledCredits(A)).toBe(2);
    expect((await reportPendingUsage(db, { client: fake, now: NOW })).claimed).toBe(0);
    expect(await enqueueBillableUsage(db, { now: NOW })).toBe(0);
    expect(fake.settledCredits(A)).toBe(2);
    expect((await outbox(A)).every((row) => row.status === 'reported')).toBe(true);
  });

  it('is idempotent on retry: a failed settle reuses the stored reservation and counts once', async () => {
    await action(A, 'act_retry');
    await enqueueBillableUsage(db, { now: NOW });
    fake.failNext('settleReservation', new BillingServiceError('Billing request failed', 503));
    expect(await reportPendingUsage(db, { client: fake, now: NOW })).toMatchObject({ retried: 1 });
    const pending = (await outbox(A))[0];
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
    expect(pending?.reservation_id).toBeTruthy();

    // Not due yet: nothing is retried early.
    expect((await reportPendingUsage(db, { client: fake, now: NOW })).claimed).toBe(0);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(await reportPendingUsage(db, { client: fake, now: later })).toMatchObject({
      reported: 1
    });
    expect(fake.calls.filter((call) => call.method === 'reserveCredits')).toHaveLength(1);
    expect(fake.reservations.size).toBe(1);
    expect(fake.settledCredits(A)).toBe(1);
  });

  it('reuses the Billing reservation when a reserve response was lost', async () => {
    await action(A, 'act_lost');
    await enqueueBillableUsage(db, { now: NOW });
    const id = usageEventId(A, 'credits', 'linkedin_action', 'act_lost');
    // Billing created the reservation, but Trevra never stored its id.
    await fake.reserveCredits({
      workspaceId: A,
      amount: '1',
      operation: 'linkedin_action',
      idempotencyKey: usageReservationKey(id, 0)
    });
    expect(await reportPendingUsage(db, { client: fake, now: NOW })).toMatchObject({ reported: 1 });
    expect(fake.reservations.size).toBe(1);
    expect(fake.settledCredits(A)).toBe(1);
  });

  it('moves to a new reservation generation only when the old one expired unsettled', async () => {
    await action(A, 'act_expired');
    await enqueueBillableUsage(db, { now: NOW });
    fake.failNext(
      'settleReservation',
      new BillingServiceError('Reservation expired before settlement', 409)
    );
    expect(await reportPendingUsage(db, { client: fake, now: NOW })).toMatchObject({ retried: 1 });
    expect((await outbox(A))[0]).toMatchObject({ reservation_id: null, reservation_generation: 1 });
    expect(await reportPendingUsage(db, { client: fake, now: NOW })).toMatchObject({ reported: 1 });
    const keys = fake.calls
      .filter((call) => call.method === 'reserveCredits')
      .map((call) => call.idempotencyKey);
    const id = usageEventId(A, 'credits', 'linkedin_action', 'act_expired');
    expect(keys).toEqual([usageReservationKey(id, 0), usageReservationKey(id, 1)]);
    expect(fake.settledCredits(A)).toBe(1);
  });

  it('keeps usage Billing refuses as rejected and never retries it under a new key', async () => {
    fake.set(A, { available: 0 });
    await action(A, 'act_refused');
    await enqueueBillableUsage(db, { now: NOW });
    expect(await reportPendingUsage(db, { client: fake, now: NOW })).toMatchObject({ rejected: 1 });
    expect((await outbox(A))[0]).toMatchObject({ status: 'rejected' });
    expect(
      (await reportPendingUsage(db, { client: fake, now: new Date(NOW.getTime() + 86_400_000) }))
        .claimed
    ).toBe(0);
  });

  it('prunes only finished rows past retention', async () => {
    await action(A, 'act_old');
    await action(A, 'act_pending', { at: new Date(NOW.getTime() - 30_000) });
    await enqueueBillableUsage(db, { now: NOW });
    await db
      .prepare(
        "UPDATE billing_usage_outbox SET status='reported', finished_at=? WHERE source_id='act_old'"
      )
      .run(new Date(NOW.getTime() - 91 * 86_400_000).toISOString());
    expect(await pruneBillingUsage(db, NOW)).toBe(1);
    expect((await outbox(A)).map((row) => row.source_id)).toEqual(['act_pending']);
  });
});

describe('runBillingMaintenance', () => {
  it('does nothing when Billing is not configured', async () => {
    await action(A, 'act_unconfigured');
    expect(await runBillingMaintenance(db, { client: null, now: NOW })).toMatchObject({
      enabled: false,
      enqueued: 0
    });
    expect(await outbox(A)).toEqual([]);
  });

  it('enqueues and reports usage in one pass', async () => {
    await action(A, 'act_maint');
    const result = await runBillingMaintenance(db, { client: fake, now: NOW });
    expect(result).toMatchObject({ enabled: true, enqueued: 1, reported: 1, errors: [] });
    expect(fake.settledCredits(A)).toBe(1);
  });
});
