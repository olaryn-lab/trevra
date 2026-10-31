/**
 * TRV-020 sender capacity, end to end on real PostgreSQL.
 *
 * Every scenario writes through the real writers (seat settings, campaigns,
 * the planner), executes through the real worker loop (`runLinkedInLocalBatch`
 * over `postgresLocalWorkerStore`) with the production safety evaluation and
 * policy gate, and reads back through the routes the screens use
 * (`GET /api/linkedin/limits`, campaign operations). Only the browser driver
 * is a double. Does not prove live LinkedIn behaviour.
 */
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import {
  approveLinkedInAction,
  linkedinActionPolicyGate,
  reviewLinkedInAction
} from './action-policy.js';
import type { LinkedInDriver, LinkedInPage } from './driver.js';
import { evaluateLinkedInSafety } from './guard.js';
import { resolveLinkedInHandoff } from './handoff.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  bandForSeat,
  dayOverDayCeiling,
  effectiveDailyCeiling,
  seatOperatorLimit,
  type PacedKind
} from './limits.js';
import {
  autonomousWindowOpen,
  claimSeatLease,
  postgresLocalWorkerStore,
  runLinkedInLocalBatch,
  type LocalBatchDeps
} from './local-worker.js';
import { createManagedCampaign, startManagedCampaign } from './managed-campaigns.js';
import { dayShapeFor, workWindowOf, zonedToUtc, type LocalDate } from './pacing.js';
import { runManagedCampaigns } from './runner.js';
import { getSeat, upsertSeat, type SeatPatch } from './seats.js';
import { saveWorkflow } from './workflows.js';

const WS = 'ws_trv020_capacity';
/** A Wednesday, 12:00 UTC: inside a 08:00-18:00 UTC window even after its 45-minute edge jitter. */
const NOW = new Date('2026-10-28T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let db: Db;
let app: Express;
let token: string;
let sequence = 0;

const UTC_WEEKDAYS: SeatPatch = {
  label: 'Owner',
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workStartMinute: 480,
  workEndMinute: 1080
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  for (const table of [
    'linkedin_seat_leases',
    'linkedin_actions',
    'linkedin_campaign_members',
    'linkedin_campaigns',
    'linkedin_workflows',
    'linkedin_lead_contacts',
    'linkedin_lead_lists',
    'linkedin_seats'
  ]) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WS);
  }
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,now()) ON CONFLICT (id) DO NOTHING'
    )
    .run(WS, 'TRV-020 capacity');
  const user = `usr_${WS}`;
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,now()) ON CONFLICT (id) DO NOTHING'
    )
    .run(user, WS, `${user}@trevra.test`, 'Owner');
  token = randomBytes(32).toString('hex');
  await db
    .prepare(
      "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,now()+interval '3650 days',now())"
    )
    .run(createHash('sha256').update(token).digest('hex'), user);
});

afterEach(async () => {
  vi.useRealTimers();
  await db?.close();
});

interface LimitRow {
  kind: string;
  window: 'day' | 'week' | 'month';
  ceiling: number;
  used: number;
  remaining: number;
  boundBy: string;
  today?: { ceiling: number; used: number; remaining: number; boundBy: string; rule: string };
}

/** What the accounts screen reads, at the instant `at`. */
async function reportAt(at: Date, seatKey = 'owner') {
  vi.setSystemTime(at);
  const response = await request(app)
    .get(`/api/linkedin/limits?seatKey=${seatKey}`)
    .set('Cookie', `trevra_session=${token}`)
    .expect(200);
  return response.body as {
    limits: LimitRow[];
    signals: { acceptance: { throttled: boolean; throttleFactor: number; rule: string } };
  };
}

async function limitsAt(at: Date, seatKey = 'owner'): Promise<LimitRow[]> {
  return (await reportAt(at, seatKey)).limits;
}

function row(limits: LimitRow[], kind: string, window: LimitRow['window'] = 'day'): LimitRow {
  const found = limits.find((entry) => entry.kind === kind && entry.window === window);
  if (!found) throw new Error(`no ${window} row for ${kind}`);
  return found;
}

/** Planned, due, campaign-less rows the worker can claim. */
async function plant(kind: string, count: number, at: Date, seatKey = 'owner'): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    sequence += 1;
    await db
      .prepare(
        `INSERT INTO linkedin_actions
           (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,replay_scope,created_at)
         VALUES (?,?,?,?,?,'planned',?::timestamptz,'plan','legacy',?::timestamptz)`
      )
      .run(
        `lact_trv020_${sequence}`,
        WS,
        seatKey,
        kind,
        `https://www.linkedin.com/in/trv020-${sequence}/`,
        at.toISOString(),
        at.toISOString()
      );
  }
}

/** Invites need the owner's exact-payload approval under the default policy; give it the real way. */
async function approvePlanned(kind: string): Promise<void> {
  const rows = await db
    .prepare(`SELECT id FROM linkedin_actions WHERE workspace_id=? AND kind=? AND status='planned'`)
    .all<{ id: string }>(WS, kind);
  for (const { id } of rows) {
    const review = await reviewLinkedInAction(db, WS, id);
    await approveLinkedInAction(db, WS, id, review!.contentHash, `usr_${WS}`, NOW);
  }
}

/** Executed history, as the ledger records it. */
async function recorded(
  kind: string,
  count: number,
  at: Date,
  status = 'sent',
  seatKey = 'owner'
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    sequence += 1;
    await db
      .prepare(
        `INSERT INTO linkedin_actions
           (id,workspace_id,seat_key,kind,target_ref,status,planned_for,recorded_at,source,replay_scope,created_at)
         VALUES (?,?,?,?,?,?,?::timestamptz,?::timestamptz,'plan','legacy',?::timestamptz)`
      )
      .run(
        `lact_trv020_${sequence}`,
        WS,
        seatKey,
        kind,
        `https://www.linkedin.com/in/trv020-${sequence}/`,
        status,
        at.toISOString(),
        at.toISOString(),
        at.toISOString()
      );
  }
}

/** The production evaluation (`local-worker.ts` worker loop), minus reply verification. */
const productionEvaluate: LocalBatchDeps['evaluate'] = (action, at) =>
  evaluateLinkedInSafety(
    db,
    {
      workspaceId: action.workspaceId,
      seatKey: action.seatKey,
      kind: action.kind as PacedKind,
      targetRef: action.targetRef,
      plannedFor: at.toISOString(),
      ...(action.campaignId ? { campaignId: action.campaignId } : {}),
      ...(action.replayScope ? { replayScope: action.replayScope } : {}),
      ...(action.manual ? { manual: true } : {})
    },
    at,
    { excludeActionId: action.id }
  );

async function work(at: Date, seatKey = 'owner', maxActions = 80) {
  const calls: Array<{ method: string; target: string }> = [];
  const done = (method: string) => async (_page: LinkedInPage, target: string) => {
    calls.push({ method, target });
    return { ok: true, externalRef: `trv020-${calls.length}`, failureKind: null };
  };
  const result = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, seatKey), {
    driver: {
      viewProfile: done('viewProfile'),
      sendInvite: done('sendInvite'),
      followProfile: done('followProfile')
    } as unknown as LinkedInDriver,
    page: {} as LinkedInPage,
    now: () => at,
    sleep: async () => {},
    log: (line) => process.env.TRV020_DEBUG && console.log(line),
    maxActions,
    evaluate: productionEvaluate,
    authorizeAction: (action) => linkedinActionPolicyGate(db, WS, action.id)
  });
  return { result, calls };
}

/** One more action of `kind` at `at`, through the same gate. */
async function nextVerdict(kind: PacedKind, at: Date, seatKey = 'owner') {
  sequence += 1;
  return evaluateLinkedInSafety(
    db,
    {
      workspaceId: WS,
      seatKey,
      kind,
      targetRef: `https://www.linkedin.com/in/trv020-next-${sequence}/`,
      plannedFor: at.toISOString()
    },
    at
  );
}

const failed = (verdict: Awaited<ReturnType<typeof nextVerdict>>) =>
  verdict.checks.filter((check) => !check.passed).map((check) => check.check);

async function profileViewWorkflow(): Promise<string> {
  return (
    await saveWorkflow(
      db,
      {
        workspaceId: WS,
        name: 'View',
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      },
      NOW
    )
  ).id;
}

async function inviteWorkflow(): Promise<string> {
  return (
    await saveWorkflow(
      db,
      {
        workspaceId: WS,
        name: 'Invite',
        steps: [
          {
            id: 'invite',
            action: 'connection_request',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      },
      NOW
    )
  ).id;
}

async function runningCampaign(
  name: string,
  leads: number,
  workflowId: string,
  createdAt: Date = NOW
): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WS, name }, createdAt);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const csv = [
    'First Name,Last Name,Company,Email,LinkedIn URL',
    ...Array.from(
      { length: leads },
      (_, index) =>
        `Lead${index},${name},Acme,${slug}-${index}@test.test,https://www.linkedin.com/in/${slug}-${index}`
    )
  ].join('\n');
  expect(
    (await importLeadCsv(db, { workspaceId: WS, listId: list.id, csv }, createdAt)).inserted
  ).toBe(leads);
  const made = await createManagedCampaign(
    db,
    { workspaceId: WS, name, leadListId: list.id, workflowId },
    createdAt
  );
  await startManagedCampaign(db, WS, made.campaign.id, createdAt);
  return made.campaign.id;
}

async function plannedByCampaign(kind: string): Promise<Record<string, number>> {
  const rows = await db
    .prepare(
      `SELECT campaign_id, COUNT(*)::int AS total FROM linkedin_actions
       WHERE workspace_id=? AND kind=? AND status='planned' GROUP BY campaign_id`
    )
    .all<{ campaign_id: string; total: number }>(WS, kind);
  return Object.fromEntries(rows.map((entry) => [entry.campaign_id, Number(entry.total)]));
}

async function operations(campaignId: string, at: Date) {
  vi.setSystemTime(at);
  const response = await request(app)
    .get(`/api/linkedin/manager/campaigns/${campaignId}/operations`)
    .set('Cookie', `trevra_session=${token}`)
    .expect(200);
  return response.body.queues as {
    allocatedCampaignDay: Record<'invite' | 'dm' | 'profile_view' | 'follow', number>;
    allocatedSeatDay: Record<'invite' | 'dm' | 'profile_view' | 'follow', number>;
  };
}

const sum = (values: Record<string, number>) =>
  Object.values(values).reduce((total, value) => total + value, 0);

describe('TRV-020 sender capacity: screens, planner and worker agree', () => {
  it('daily ceiling: the screen\'s "effective today" is exactly what the worker sends, and one past it is refused', async () => {
    await upsertSeat(
      db,
      WS,
      {
        ...UTC_WEEKDAYS,
        dailyProfileViewLimit: 20,
        safetyBandOverride: true,
        warmupOverride: true
      },
      new Date('2026-01-01T09:00:00.000Z')
    );

    const before = row(await limitsAt(NOW), 'profile_view');
    // The structural number...
    expect(before.ceiling).toBe(20);
    // ...and what the send-time gate admits today: the seeded day draw takes
    // 85-100% of it. The screen quotes this one as "effective today", and the
    // planner budgets with it.
    const today = before.today!;
    expect(today.ceiling).toBeGreaterThanOrEqual(Math.floor(20 * 0.85));
    expect(today.ceiling).toBeLessThanOrEqual(20);
    expect(today).toMatchObject({ used: 0, remaining: today.ceiling });

    await plant('profile_view', today.ceiling + 3, new Date(NOW.getTime() - MINUTE));
    const { result, calls } = await work(NOW);
    expect(result.executed).toBe(today.ceiling);
    expect(result.blocked).toBe(3);
    expect(calls.filter((call) => call.method === 'viewProfile')).toHaveLength(today.ceiling);

    // One past the boundary: the same gate refuses, on the daily checks.
    const past = await nextVerdict('profile_view', NOW);
    expect(past.allowed).toBe(false);
    expect(failed(past)).toEqual(expect.arrayContaining(['rolling-24h']));

    const after = row(await limitsAt(NOW), 'profile_view');
    expect(after.used).toBe(today.ceiling);
    expect(after.today).toMatchObject({ used: today.ceiling, remaining: 0 });
    const stillPlanned = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_actions
         WHERE workspace_id=? AND status='planned' AND claimed_at IS NULL`
      )
      .get<{ total: number }>(WS);
    expect(Number(stillPlanned?.total)).toBe(3);
  });

  it('weekly ceiling counts the whole invite family on screen and at the gate, at the boundary and one past', async () => {
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, warmupOverride: true },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const seat = await getSeat(db, WS, 'owner');
    const perWeek = bandForSeat('invite', 'steady', seat).perWeek!;
    expect(perWeek).toBeGreaterThan(1);

    // perWeek-1 decided invites over the last 2-6 days, half of them event
    // invites: the gate spends one weekly band across the invite family.
    for (let index = 0; index < perWeek - 1; index += 1) {
      await recorded(
        index % 2 === 0 ? 'event_invite' : 'invite',
        1,
        new Date(NOW.getTime() - 36 * HOUR - index * 30 * MINUTE),
        'accepted'
      );
    }

    const before = await limitsAt(NOW);
    expect(row(before, 'invite', 'week')).toMatchObject({ used: perWeek - 1, remaining: 1 });
    expect(row(before, 'invite').today).toMatchObject({ remaining: 1, boundBy: 'weekly-band' });

    await plant('invite', 3, new Date(NOW.getTime() - MINUTE));
    await approvePlanned('invite');
    const { result, calls } = await work(NOW);
    expect(result.executed).toBe(1);
    expect(result.blocked).toBe(2);
    expect(calls.map((call) => call.method)).toEqual(['sendInvite']);

    const past = await nextVerdict('invite', NOW);
    expect(past.allowed).toBe(false);
    expect(failed(past)).toEqual(['rolling-7d']);

    const after = await limitsAt(NOW);
    expect(row(after, 'invite', 'week')).toMatchObject({ used: perWeek, remaining: 0 });
    expect(row(after, 'invite').today).toMatchObject({ remaining: 0, boundBy: 'weekly-band' });
  });

  it('low invite acceptance is advisory: the screen does not halve the ceiling the planner and gate use', async () => {
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, dailyInviteLimit: 20, safetyBandOverride: true, warmupOverride: true },
      new Date('2026-01-01T09:00:00.000Z')
    );
    // 1 of 11 decided invites accepted this week: far below the 30% floor.
    await recorded('invite', 10, new Date(NOW.getTime() - 3 * DAY), 'declined');
    await recorded('invite', 1, new Date(NOW.getTime() - 3 * DAY), 'accepted');

    const report = await reportAt(NOW);
    expect(report.signals.acceptance.throttled).toBe(true);
    expect(report.signals.acceptance.throttleFactor).toBe(1);
    expect(report.signals.acceptance.rule).toMatch(/advisory/);
    const invite = row(report.limits, 'invite');
    expect(invite.ceiling).toBe(20);
    expect(invite.boundBy).not.toBe('acceptance-rate');
    const today = invite.today!;
    expect(today.ceiling).toBeGreaterThanOrEqual(Math.floor(20 * 0.85));

    await plant('invite', today.remaining + 1, new Date(NOW.getTime() - MINUTE));
    await approvePlanned('invite');
    const { result } = await work(NOW);
    expect(result.executed).toBe(today.remaining);
    expect(result.blocked).toBe(1);
    const past = await nextVerdict('invite', NOW);
    expect(failed(past)).not.toContain('acceptance-rate');
    expect(failed(past)).toContain('rolling-24h');
  });

  it('working hours follow the seat timezone across the US DST change, at the window edge and one minute past', async () => {
    const timezone = 'America/New_York';
    await upsertSeat(
      db,
      WS,
      {
        label: 'Owner',
        timezone,
        workingDays: [1, 2, 3, 4, 5],
        workStartMinute: 540,
        workEndMinute: 1020,
        dailyProfileViewLimit: 20,
        safetyBandOverride: true,
        warmupOverride: true
      },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const seat = await getSeat(db, WS, 'owner');
    const window = workWindowOf(seat);
    // 09:00 local is 13:00Z on EDT Friday and 14:00Z on EST Monday.
    expect(zonedToUtc({ year: 2026, month: 10, day: 30 }, 540 * 60, timezone).toISOString()).toBe(
      '2026-10-30T13:00:00.000Z'
    );
    expect(zonedToUtc({ year: 2026, month: 11, day: 2 }, 540 * 60, timezone).toISOString()).toBe(
      '2026-11-02T14:00:00.000Z'
    );

    for (const date of [
      { year: 2026, month: 10, day: 30 },
      { year: 2026, month: 11, day: 2 }
    ] satisfies LocalDate[]) {
      const shape = dayShapeFor(`${WS}:owner`, date, window);
      expect(shape.startMinute).toBeGreaterThanOrEqual(540);
      expect(shape.endMinute).toBeLessThanOrEqual(1020);
      const start = zonedToUtc(date, shape.startMinute * 60, timezone);
      const end = zonedToUtc(date, shape.endMinute * 60, timezone);
      const early = new Date(start.getTime() - MINUTE);
      const lastMinute = new Date(end.getTime() - MINUTE);

      // The worker's own wake-up predicate and the gate agree on both edges.
      expect(await autonomousWindowOpen(db, WS, 'owner', early)).toBe(false);
      expect(await autonomousWindowOpen(db, WS, 'owner', start)).toBe(true);
      expect(await autonomousWindowOpen(db, WS, 'owner', lastMinute)).toBe(true);
      expect(await autonomousWindowOpen(db, WS, 'owner', end)).toBe(false);

      await plant('profile_view', 1, new Date(start.getTime() - 2 * HOUR));
      const tooEarly = await work(early);
      expect(tooEarly.result).toMatchObject({ executed: 0, blocked: 1 });
      expect(failed(await nextVerdict('profile_view', early))).toContain('business-hours');
      expect((await work(start)).result.executed).toBe(1);

      await plant('profile_view', 1, start);
      expect((await work(lastMinute)).result.executed).toBe(1);
      await plant('profile_view', 1, start);
      const tooLate = await work(end);
      expect(tooLate.result).toMatchObject({ executed: 0, blocked: 1 });
      expect(tooLate.calls).toHaveLength(0);
      await db
        .prepare(`DELETE FROM linkedin_actions WHERE workspace_id=? AND status='planned'`)
        .run(WS);
    }

    // Saturday noon in New York is not a working day.
    const saturday = zonedToUtc({ year: 2026, month: 10, day: 31 }, 720 * 60, timezone);
    expect(await autonomousWindowOpen(db, WS, 'owner', saturday)).toBe(false);
    await plant('profile_view', 1, new Date(saturday.getTime() - HOUR));
    expect((await work(saturday)).result).toMatchObject({ executed: 0, blocked: 1 });
  });

  it('warm-up ramp: week 1 ramps active kinds only, and a cold seat starts at the day-over-day step on screen and at the gate', async () => {
    await upsertSeat(db, WS, UTC_WEEKDAYS, new Date(NOW.getTime() - 3 * DAY));
    const seat = await getSeat(db, WS, 'owner');
    const structural = (kind: PacedKind) =>
      effectiveDailyCeiling(
        bandForSeat(kind, 'warmup', seat).perDay,
        seatOperatorLimit(seat, kind),
        false
      );

    const week1 = await limitsAt(NOW);
    expect(row(week1, 'invite')).toMatchObject({
      ceiling: Math.floor(structural('invite') * 0.5),
      boundBy: 'warmup-multiplier'
    });
    // Passive kinds are not reduced by the account warm-up multiplier.
    expect(row(week1, 'profile_view').ceiling).toBe(structural('profile_view'));
    expect(row(week1, 'profile_view').boundBy).not.toBe('warmup-multiplier');
    // No history at all: the gate's cold-account ramp admits one of each today,
    // and that is the number the screen now quotes.
    for (const kind of ['invite', 'profile_view']) {
      expect(row(week1, kind).today).toMatchObject({
        ceiling: dayOverDayCeiling(0),
        remaining: dayOverDayCeiling(0),
        boundBy: 'day-over-day-delta'
      });
    }

    await plant('invite', 3, new Date(NOW.getTime() - MINUTE));
    await approvePlanned('invite');
    await plant('profile_view', 3, new Date(NOW.getTime() - MINUTE));
    const { result, calls } = await work(NOW);
    expect(result.executed).toBe(2 * dayOverDayCeiling(0));
    expect(calls.map((call) => call.method).sort()).toEqual(['sendInvite', 'viewProfile']);
    const after = await limitsAt(NOW);
    expect(row(after, 'invite').today?.remaining).toBe(0);
    expect(row(after, 'profile_view').today?.remaining).toBe(0);

    // Week 2, with three business days of history: the ramp grows from what
    // the seat actually did, and the screen and the worker still agree.
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, label: 'Ramp' },
      new Date(NOW.getTime() - 10 * DAY),
      'ramp'
    );
    for (const daysAgo of [1, 2, 5]) {
      await recorded(
        'profile_view',
        6,
        new Date(NOW.getTime() - daysAgo * DAY - HOUR),
        'sent',
        'ramp'
      );
    }
    const ramp = await getSeat(db, WS, 'ramp');
    const week2 = await limitsAt(NOW, 'ramp');
    expect(row(week2, 'invite').ceiling).toBe(
      Math.floor(
        effectiveDailyCeiling(
          bandForSeat('invite', 'warmup', ramp).perDay,
          seatOperatorLimit(ramp, 'invite'),
          false
        ) * 0.8
      )
    );
    const rampToday = row(week2, 'profile_view').today!;
    expect(rampToday.remaining).toBeGreaterThan(dayOverDayCeiling(0));
    expect(rampToday.remaining).toBeLessThanOrEqual(dayOverDayCeiling(6));
    await plant('profile_view', rampToday.remaining + 2, new Date(NOW.getTime() - MINUTE), 'ramp');
    const rampRun = await work(NOW, 'ramp');
    expect(rampRun.result.executed).toBe(rampToday.remaining);
    expect(rampRun.result.blocked).toBe(2);
    expect(row(await limitsAt(NOW, 'ramp'), 'profile_view').today?.remaining).toBe(0);
  });

  it('two campaigns on one seat share one budget: the planner splits it, both cards show the same seat remaining, and sends stop at the seat ceiling', async () => {
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, dailyProfileViewLimit: 6, safetyBandOverride: true, warmupOverride: true },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const workflowId = await profileViewWorkflow();
    const first = await runningCampaign('Alpha', 6, workflowId);
    const second = await runningCampaign('Beta', 6, workflowId);

    // What the gate admits today: the planner's whole budget for the seat.
    const today = row(await limitsAt(NOW), 'profile_view').today!;
    await runManagedCampaigns(db, WS, NOW);
    const planned = await plannedByCampaign('profile_view');
    expect(sum(planned)).toBe(today.remaining);
    expect(planned[first]).toBeGreaterThan(0);
    expect(planned[second]).toBeGreaterThan(0);
    // A second tick does not find the seat's budget again.
    await runManagedCampaigns(db, WS, new Date(NOW.getTime() + MINUTE));
    expect(sum(await plannedByCampaign('profile_view'))).toBe(today.remaining);

    const seatCeiling = row(await limitsAt(NOW), 'profile_view').ceiling;
    expect(seatCeiling).toBe(6);
    const alpha = await operations(first, NOW);
    const beta = await operations(second, NOW);
    expect(alpha.allocatedCampaignDay.profile_view + beta.allocatedCampaignDay.profile_view).toBe(
      today.remaining
    );
    // Both cards price the SEAT: all of today's allowance allocated, none left
    // -- not the whole allowance left twice.
    expect(alpha.allocatedSeatDay.profile_view).toBe(today.remaining);
    expect(beta.allocatedSeatDay.profile_view).toBe(today.remaining);
    expect(Math.max(0, today.remaining - alpha.allocatedSeatDay.profile_view)).toBe(0);
    expect(Math.max(0, today.remaining - beta.allocatedSeatDay.profile_view)).toBe(0);

    // Bring every planned row due now; the worker sends every one of them,
    // which is exactly what the gate admits today, and never past the seat ceiling.
    await db
      .prepare(
        `UPDATE linkedin_actions SET planned_for=?::timestamptz WHERE workspace_id=? AND status='planned'`
      )
      .run(new Date(NOW.getTime() - MINUTE).toISOString(), WS);
    const { result } = await work(NOW);
    expect(result.executed).toBe(today.remaining);
    expect(result.executed).toBeLessThanOrEqual(seatCeiling);
    expect(result.blocked).toBe(0);
    expect(failed(await nextVerdict('profile_view', NOW))).toContain('rolling-24h');
  });

  it('concurrent planner ticks and competing workers cannot exceed the seat', async () => {
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, dailyProfileViewLimit: 6, safetyBandOverride: true, warmupOverride: true },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const workflowId = await profileViewWorkflow();
    for (const name of ['One', 'Two', 'Three']) await runningCampaign(name, 4, workflowId);

    const allowance = row(await limitsAt(NOW), 'profile_view').today!.remaining;
    await Promise.all([0, 1, 2, 3].map(() => runManagedCampaigns(db, WS, NOW)));
    expect(sum(await plannedByCampaign('profile_view'))).toBe(allowance);

    const lease = (workerId: string, at: Date) =>
      claimSeatLease(
        db,
        {
          workspaceId: WS,
          seatKey: 'owner',
          workerId,
          host: 'trv020-host',
          profileDir: '/tmp/trv020-owner'
        },
        at
      );
    const leases = await Promise.all(['w1', 'w2', 'w3'].map((id) => lease(id, NOW)));
    expect(leases.filter((outcome) => outcome.ok)).toHaveLength(1);

    // Two workers shaped like production (lease, then batch) race for the seat.
    await db.prepare('DELETE FROM linkedin_seat_leases WHERE workspace_id=?').run(WS);
    await db
      .prepare(
        `UPDATE linkedin_actions SET planned_for=?::timestamptz WHERE workspace_id=? AND status='planned'`
      )
      .run(new Date(NOW.getTime() - MINUTE).toISOString(), WS);
    const today = row(await limitsAt(NOW), 'profile_view').today!;
    const leasedBatch = async (workerId: string) => {
      const held = await lease(workerId, NOW);
      return held.ok ? (await work(NOW)).result.executed : null;
    };
    const outcomes = await Promise.all([leasedBatch('a'), leasedBatch('b')]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    const sent = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=? AND status='sent'`
      )
      .get<{ total: number }>(WS);
    expect(Number(sent?.total)).toBe(today.remaining);
    expect(Number(sent?.total)).toBeLessThanOrEqual(6);
  });
});

/** Every unexecuted row of `kind` on the seat, whichever route queued it. */
async function plannedOnSeat(kind: string, seatKey = 'owner'): Promise<number> {
  const found = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM linkedin_actions
       WHERE workspace_id=? AND seat_key=? AND kind=? AND status='planned'`
    )
    .get<{ total: number }>(WS, seatKey, kind);
  return Number(found?.total ?? 0);
}

/** Every planned row due a minute before `at`, so one worker pass can reach all of them. */
async function bringDue(at: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_actions SET planned_for=?::timestamptz WHERE workspace_id=? AND status='planned'`
    )
    .run(new Date(at.getTime() - MINUTE).toISOString(), WS);
}

describe('TRV-020 the planner sizes each seat from the send gate allowance', () => {
  it('warming seat: the planner plans exactly what the gate admits today, not the structural ceiling, and one more tick plans nothing', async () => {
    await upsertSeat(db, WS, UTC_WEEKDAYS, new Date(NOW.getTime() - 3 * DAY));
    const workflowId = await profileViewWorkflow();
    const campaign = await runningCampaign('Warm', 8, workflowId);

    const before = row(await limitsAt(NOW), 'profile_view');
    const today = before.today!;
    // A cold seat with no history: the gate's day-over-day ramp binds far
    // below the structural number the planner used to budget with.
    expect(today).toMatchObject({ remaining: dayOverDayCeiling(0), boundBy: 'day-over-day-delta' });
    expect(before.ceiling).toBeGreaterThan(8);

    await runManagedCampaigns(db, WS, NOW);
    expect(await plannedByCampaign('profile_view')).toEqual({ [campaign]: today.remaining });
    // At the boundary a second tick finds no room.
    await runManagedCampaigns(db, WS, new Date(NOW.getTime() + MINUTE));
    expect(await plannedOnSeat('profile_view')).toBe(today.remaining);

    // Everything planned goes out; nothing is left for the gate to refuse.
    await bringDue(NOW);
    const { result } = await work(NOW);
    expect(result).toMatchObject({ executed: today.remaining, blocked: 0 });

    // One past: the gate refuses the next one and the planner does not plan it.
    expect(failed(await nextVerdict('profile_view', NOW))).toContain('day-over-day-delta');
    await runManagedCampaigns(db, WS, new Date(NOW.getTime() + 2 * MINUTE));
    expect(await plannedOnSeat('profile_view')).toBe(0);
  });

  it('partly-used seat: sends the gate counts and rows other routes queued come off the plan, one below the boundary, at it and one past', async () => {
    await upsertSeat(
      db,
      WS,
      {
        ...UTC_WEEKDAYS,
        dailyProfileViewLimit: 10,
        safetyBandOverride: true,
        warmupOverride: true
      },
      new Date('2026-01-01T09:00:00.000Z')
    );
    // Three views another route planned yesterday morning and the worker sent
    // two hours ago: the gate counts them by `recorded_at`, inside its rolling
    // 24 hours, although they were planned outside it.
    for (let index = 0; index < 3; index += 1) {
      sequence += 1;
      await db
        .prepare(
          `INSERT INTO linkedin_actions
             (id,workspace_id,seat_key,kind,target_ref,status,planned_for,recorded_at,source,replay_scope,created_at)
           VALUES (?,?,?,?,?,'sent',?::timestamptz,?::timestamptz,'plan','legacy',?::timestamptz)`
        )
        .run(
          `lact_trv020_${sequence}`,
          WS,
          'owner',
          'profile_view',
          `https://www.linkedin.com/in/trv020-${sequence}/`,
          new Date(NOW.getTime() - 30 * HOUR).toISOString(),
          new Date(NOW.getTime() - 2 * HOUR).toISOString(),
          new Date(NOW.getTime() - 30 * HOUR).toISOString()
        );
    }
    const today = row(await limitsAt(NOW), 'profile_view').today!;
    expect(today.used).toBe(3);
    expect(today.remaining).toBeGreaterThan(1);
    // Another route's queue, one short of the allowance, due later today.
    await plant('profile_view', today.remaining - 1, new Date(NOW.getTime() + 30 * MINUTE));

    const workflowId = await profileViewWorkflow();
    const campaign = await runningCampaign('Partly', 8, workflowId);
    await runManagedCampaigns(db, WS, NOW);
    // One below the boundary: exactly one more row.
    expect((await plannedByCampaign('profile_view'))[campaign]).toBe(1);
    expect(await plannedOnSeat('profile_view')).toBe(today.remaining);
    // At the boundary: nothing more.
    await runManagedCampaigns(db, WS, new Date(NOW.getTime() + MINUTE));
    expect(await plannedOnSeat('profile_view')).toBe(today.remaining);

    await bringDue(NOW);
    const { result } = await work(NOW);
    expect(result).toMatchObject({ executed: today.remaining, blocked: 0 });
    // One past.
    expect(failed(await nextVerdict('profile_view', NOW))).toContain('rolling-24h');
  });

  it('weekly band: a seat near its rolling 7-day invite band plans only what the week has left', async () => {
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, warmupOverride: true },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const seat = await getSeat(db, WS, 'owner');
    const perWeek = bandForSeat('invite', 'steady', seat).perWeek!;
    // Two short of the week, decided over the last 2-4 days.
    for (let index = 0; index < perWeek - 2; index += 1) {
      await recorded(
        'invite',
        1,
        new Date(NOW.getTime() - 36 * HOUR - index * 30 * MINUTE),
        'accepted'
      );
    }
    const today = row(await limitsAt(NOW), 'invite').today!;
    expect(today).toMatchObject({ remaining: 2, boundBy: 'weekly-band' });

    const campaign = await runningCampaign('Weekly', 6, await inviteWorkflow());
    await runManagedCampaigns(db, WS, NOW);
    expect(await plannedByCampaign('invite')).toEqual({ [campaign]: 2 });
    await runManagedCampaigns(db, WS, new Date(NOW.getTime() + MINUTE));
    expect(await plannedOnSeat('invite')).toBe(2);

    await bringDue(NOW);
    await approvePlanned('invite');
    const { result } = await work(NOW);
    expect(result).toMatchObject({ executed: 2, blocked: 0 });
    expect(failed(await nextVerdict('invite', NOW))).toEqual(['rolling-7d']);
  });

  it('a hand send recorded late on a cancelled hand-off comes off the plan exactly as the gate counts it', async () => {
    await upsertSeat(
      db,
      WS,
      {
        ...UTC_WEEKDAYS,
        sendMode: 'human',
        dailyInviteLimit: 5,
        safetyBandOverride: true,
        warmupOverride: true
      },
      new Date('2026-01-01T09:00:00.000Z')
    );
    // A hand-off Today presented 30 hours ago that a bulk path then cancelled
    // before the founder answered it (TRV-043): skipped, counted nowhere.
    sequence += 1;
    const handoffId = `lact_trv020_${sequence}`;
    const presentedAt = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    await db
      .prepare(
        `INSERT INTO linkedin_actions
           (id,workspace_id,seat_key,kind,target_ref,status,planned_for,handoff_presented_at,source,replay_scope,created_at)
         VALUES (?,?,?,?,?,'skipped',?::timestamptz,?::timestamptz,'plan','legacy',?::timestamptz)`
      )
      .run(
        handoffId,
        WS,
        'owner',
        'invite',
        `https://www.linkedin.com/in/trv020-late-${sequence}/`,
        presentedAt,
        presentedAt,
        presentedAt
      );
    const before = row(await limitsAt(NOW), 'invite').today!;
    expect(before.remaining).toBeGreaterThan(1);

    // The founder now reports it went out 20 hours ago: `recorded_at` is
    // back-dated into the gate's rolling day, far from its `planned_for`.
    await resolveLinkedInHandoff(
      db,
      {
        workspaceId: WS,
        actionId: handoffId,
        resolution: 'sent',
        sentAt: new Date(NOW.getTime() - 20 * HOUR).toISOString(),
        actorUserId: null
      },
      NOW
    );
    const today = row(await limitsAt(NOW), 'invite').today!;
    expect(today.used).toBe(before.used + 1);
    expect(today.remaining).toBe(before.remaining - 1);

    const campaign = await runningCampaign('Late', 8, await inviteWorkflow());
    await runManagedCampaigns(db, WS, NOW);
    expect(await plannedByCampaign('invite')).toEqual({ [campaign]: today.remaining });
  });

  it("shared seat scarcer than its campaigns: the gate's allowance rotates deterministically, none starves and nothing piles up", async () => {
    await upsertSeat(
      db,
      WS,
      { ...UTC_WEEKDAYS, dailyProfileViewLimit: 2, safetyBandOverride: true, warmupOverride: true },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const workflowId = await profileViewWorkflow();
    // Created an hour apart: oldest first is the order nobody has planned yet.
    const order: string[] = [];
    for (const [index, name] of ['Ash', 'Birch', 'Cedar'].entries()) {
      order.push(
        await runningCampaign(name, 3, workflowId, new Date(NOW.getTime() - (3 - index) * HOUR))
      );
    }
    // Wednesday, Thursday, Friday and Monday: working days, each past the
    // previous send's rolling 24 hours.
    const days = [
      NOW,
      new Date(NOW.getTime() + DAY + HOUR),
      new Date(NOW.getTime() + 2 * DAY + 2 * HOUR),
      new Date(NOW.getTime() + 5 * DAY + 3 * HOUR)
    ];
    const winners: string[] = [];
    for (const at of days) {
      // floor(2 x a draw below 1): the gate admits one a day, fewer than campaigns.
      const today = row(await limitsAt(at), 'profile_view').today!;
      expect(today.remaining).toBe(1);
      await runManagedCampaigns(db, WS, at);
      const planned = await plannedByCampaign('profile_view');
      expect(sum(planned)).toBe(today.remaining);
      winners.push(...Object.keys(planned));
      await bringDue(at);
      const { result } = await work(at);
      expect(result).toMatchObject({ executed: today.remaining, blocked: 0 });
      expect(await plannedOnSeat('profile_view')).toBe(0);
    }
    expect(winners).toEqual([order[0], order[1], order[2], order[0]]);
  });
});
