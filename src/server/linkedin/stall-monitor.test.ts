import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { seatWindowOpenNow, type ManagedCampaign } from './managed-campaigns.js';
import type { LinkedInSeat } from './seats.js';
import {
  findStalledLinkedInCampaigns,
  notifyStalledLinkedInCampaigns,
  type StalledCampaign
} from './stall-monitor.js';

const WORKSPACE = 'ws_stall_monitor_test';
const CAMPAIGN = 'licmp_stall_monitor_test';
const TIME = new Date('2026-10-27T14:00:00.000Z');
const stalled: StalledCampaign = {
  workspaceId: WORKSPACE,
  campaignId: CAMPAIGN,
  campaignName: 'Controlled launch campaign',
  seatKey: 'owner',
  oldestDue: '2026-10-27T10:00:00.000Z',
  approvedDue: 2
};
let db: Db;
const find = vi.fn(async () => [stalled]);
const notify = vi.fn(async () => true);

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Stall monitor test', TIME.toISOString());
  await db
    .prepare(
      "INSERT INTO linkedin_campaigns(id,workspace_id,name,status,seat_key) VALUES (?,?,?,'running','owner')"
    )
    .run(CAMPAIGN, WORKSPACE, 'Controlled launch campaign');
  find.mockClear();
  notify.mockClear();
});
afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db.close();
});

describe('LinkedIn campaign stall notifications', () => {
  it('sends once across repeated sweeps and again only after 24 hours', async () => {
    const run = (at: Date) => notifyStalledLinkedInCampaigns(db, { now: at, find, notify });
    expect(await run(TIME)).toEqual({ detected: 1, notified: 1, failed: 0 });
    expect(await run(new Date(TIME.getTime() + 60_000))).toEqual({
      detected: 1,
      notified: 0,
      failed: 0
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const afterDay = new Date(TIME.getTime() + 25 * 60 * 60_000);
    expect(await run(afterDay)).toMatchObject({ notified: 1 });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('uses a PostgreSQL claim to suppress simultaneous replica alerts', async () => {
    const results = await Promise.all([
      notifyStalledLinkedInCampaigns(db, { now: TIME, find, notify }),
      notifyStalledLinkedInCampaigns(db, { now: TIME, find, notify })
    ]);
    expect(results.reduce((sum, r) => sum + r.notified, 0)).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not record an unsent notification as delivered and retries after failure', async () => {
    notify.mockRejectedValueOnce(new Error('smtp temporarily unavailable')).mockResolvedValue(true);
    expect(await notifyStalledLinkedInCampaigns(db, { now: TIME, find, notify })).toMatchObject({
      notified: 0,
      failed: 1
    });
    expect(
      await notifyStalledLinkedInCampaigns(db, {
        now: new Date(TIME.getTime() + 60_000),
        find,
        notify
      })
    ).toMatchObject({ notified: 1 });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('retries after a dead worker claim expires but not while the claim is live', async () => {
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_stall_notifications
      (workspace_id,campaign_id,claimed_at,claim_token) VALUES (?,?,?::timestamptz,'dead-worker')`
      )
      .run(WORKSPACE, CAMPAIGN, TIME.toISOString());
    expect(await notifyStalledLinkedInCampaigns(db, { now: TIME, find, notify })).toMatchObject({
      notified: 0
    });
    expect(
      await notifyStalledLinkedInCampaigns(db, {
        now: new Date(TIME.getTime() + 11 * 60_000),
        find,
        notify
      })
    ).toMatchObject({ notified: 1 });
  });

  it('does not alert on a campaign with no approved overdue work', async () => {
    const result = await findStalledLinkedInCampaigns(db, TIME);
    expect(result).toEqual([]);
  });

  it('honors both campaign and account working windows including weekends', () => {
    const seat = {
      timezone: 'Europe/Zurich',
      workingDays: [1, 2, 3, 4, 5],
      workStartMinute: 9 * 60,
      workEndMinute: 17 * 60
    } as LinkedInSeat;
    const campaign = {
      schedule: {
        workingDays: [1, 2, 3, 4, 5],
        workStartMinute: 10 * 60,
        workEndMinute: 16 * 60
      }
    } as ManagedCampaign;
    expect(seatWindowOpenNow(seat, campaign, new Date('2026-10-27T12:00:00Z'))).toBe(true);
    expect(seatWindowOpenNow(seat, campaign, new Date('2026-10-27T07:30:00Z'))).toBe(false);
    expect(seatWindowOpenNow(seat, campaign, new Date('2026-10-25T12:00:00Z'))).toBe(false);
  });
});
