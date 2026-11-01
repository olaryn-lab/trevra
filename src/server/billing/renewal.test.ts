import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTransactionalEmail = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined));
vi.mock('../email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email.js')>()),
  smtpConfigured: () => true,
  sendTransactionalEmail
}));

import { openDatabase, type Db } from '../db.js';
import type { StoredBillingSnapshot } from './entitlements.js';
import { pruneRenewalNotices, sendAnnualRenewalNotices } from './renewal.js';

const A = 'ws_billing_renewal_a';
const B = 'ws_billing_renewal_b';
const NOW = new Date('2026-10-31T12:00:00.000Z');
const DAY = 86_400_000;
let db: Db;

function snapshot(patch: Partial<StoredBillingSnapshot['subscription']>): StoredBillingSnapshot {
  return {
    customer: { plan_code: 'growth_yearly_usd', currency: 'USD', has_payment_profile: true },
    subscription: {
      status: 'active',
      plan_code: 'growth_yearly_usd',
      cancel_at_period_end: false,
      current_period_end: new Date(NOW.getTime() + 20 * DAY).toISOString(),
      ...patch
    },
    credits: { balance: 0, usage: 0, available: 0, period_start: null, period_end: null },
    entitlements: { features: {} }
  };
}

async function cache(workspaceId: string, snap: StoredBillingSnapshot, fetchedAt = NOW) {
  await db
    .prepare(
      `INSERT INTO billing_workspace_state (workspace_id,snapshot_json,fetched_at)
       VALUES (?,?::jsonb,?)
       ON CONFLICT (workspace_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, fetched_at=excluded.fetched_at`
    )
    .run(workspaceId, JSON.stringify(snap), fetchedAt.toISOString());
}

function recipients(): string[] {
  return sendTransactionalEmail.mock.calls.map((call) => (call[0] as { to: string }).to).sort();
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
  for (const ws of [A, B]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(ws, ws, NOW.toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(`usr_${ws}`, ws, `owner@${ws}.test`, `Owner ${ws}`, NOW.toISOString());
  }
});

afterEach(async () => {
  await db.close();
});

describe('sendAnnualRenewalNotices', () => {
  it('notifies the owner once per renewal date, 30 days ahead, without amounts', async () => {
    await cache(A, snapshot({}));
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 1 });
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 0 });
    expect(
      await sendAnnualRenewalNotices(db, { now: new Date(NOW.getTime() + 5 * DAY) })
    ).toMatchObject({ sent: 0 });
    expect(recipients()).toEqual([`owner@${A}.test`]);
    const mail = sendTransactionalEmail.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(mail.subject).toContain('2026-11-20');
    expect(mail.text).toContain('Growth (annual)');
    expect(mail.text).not.toMatch(/\$|USD|invoice/i);
    const row = await db
      .prepare(
        'SELECT renewal_on::text AS renewal_on, notified_at FROM billing_renewal_notices WHERE workspace_id=?'
      )
      .get<{ renewal_on: string; notified_at: string | null }>(A);
    expect(row?.renewal_on).toBe('2026-11-20');
    expect(row?.notified_at).not.toBeNull();
  });

  it('sends again for the next renewal date only', async () => {
    await cache(A, snapshot({}));
    await sendAnnualRenewalNotices(db, { now: NOW });
    const nextYear = new Date(NOW.getTime() + 365 * DAY);
    await cache(
      A,
      snapshot({ current_period_end: new Date(nextYear.getTime() + 20 * DAY).toISOString() }),
      nextYear
    );
    expect(await sendAnnualRenewalNotices(db, { now: nextYear })).toMatchObject({ sent: 1 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
  });

  it('skips monthly, cancelling, trialing, far-off and stale-past-grace subscriptions', async () => {
    await cache(A, snapshot({ plan_code: 'growth_monthly_usd' }));
    await cache(B, snapshot({ cancel_at_period_end: true }));
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 0 });
    await cache(A, snapshot({ status: 'trialing' }));
    await cache(
      B,
      snapshot({ current_period_end: new Date(NOW.getTime() + 40 * DAY).toISOString() })
    );
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 0 });
    await cache(A, snapshot({}), new Date(NOW.getTime() - 73 * 3_600_000));
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 0 });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('releases the claim when delivery fails so a later pass sends it exactly once', async () => {
    await cache(A, snapshot({}));
    sendTransactionalEmail.mockRejectedValueOnce(new Error('smtp down'));
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 0, failed: 1 });
    const released = await db
      .prepare('SELECT claim_token, notified_at FROM billing_renewal_notices WHERE workspace_id=?')
      .get<{ claim_token: string | null; notified_at: string | null }>(A);
    expect(released).toEqual({ claim_token: null, notified_at: null });
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 1 });
    expect(await sendAnnualRenewalNotices(db, { now: NOW })).toMatchObject({ sent: 0 });
  });

  it('notifies each workspace its own owner, and concurrent passes send once', async () => {
    await cache(A, snapshot({}));
    await cache(B, snapshot({}));
    const results = await Promise.all([
      sendAnnualRenewalNotices(db, { now: NOW }),
      sendAnnualRenewalNotices(db, { now: NOW })
    ]);
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(2);
    expect(recipients()).toEqual([`owner@${A}.test`, `owner@${B}.test`]);
  });

  it('prunes dedupe rows 400 days after the renewal date', async () => {
    const insert = db.prepare(
      `INSERT INTO billing_renewal_notices (workspace_id,renewal_on,plan_code,notified_at)
       VALUES (?,?::date,'growth_yearly_usd',?)`
    );
    await insert.run(A, '2025-01-01', NOW.toISOString());
    await insert.run(A, '2026-06-01', NOW.toISOString());
    expect(await pruneRenewalNotices(db, NOW)).toBe(1);
  });
});
