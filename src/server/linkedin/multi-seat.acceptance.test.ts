import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import type { WorkspaceRole } from '../roles.js';
import { putLinkedInCredentials, readLinkedInCredentials } from '../secrets/linkedin.js';
import { linkedinActionPolicyGate } from './action-policy.js';
import { recordAction } from './actions.js';
import type {
  LinkedInDriver,
  LinkedInDriverResult,
  LinkedInPage,
  LinkedInSeatRead
} from './driver.js';
import type { LinkedInThreadSummary } from './driver-inbox.js';
import { evaluateLinkedInSafety } from './guard.js';
import { enqueueReply, listThreads, syncThreads, threadByUrn } from './inbox.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import type { PacedKind } from './limits.js';
import {
  closeLinkedInBrowser,
  dueSeatsForWorker,
  openBrowser,
  postgresLocalWorkerStore,
  resetLinkedInSessionRhythm,
  runLinkedInLocalBatch,
  type DueLinkedInAction,
  type PlaywrightLike
} from './local-worker.js';
import {
  createManagedCampaign,
  listCampaignMembers,
  startManagedCampaign
} from './managed-campaigns.js';
import { runManagedCampaigns } from './runner.js';
import { getSeat, upsertSeat } from './seats.js';
import { readSeatStorageState, saveSeatStorageState } from './session-state.js';
import { saveWorkflow } from './workflows.js';

/**
 * TRV-044 acceptance: several LinkedIn seats in one workspace, end to end
 * against real PostgreSQL.
 *
 * THE PROPERTY UNDER TEST IS ISOLATION. Actions, threads, ceilings and
 * credentials belong to exactly one (workspace, seat) pair; a campaign bound to
 * one seat never executes on another; who may assign or use a seat follows the
 * TRV-045 capability map; and none of it crosses a workspace boundary even when
 * two workspaces use the same seat key.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const WS = 'ws_li_multiseat_acceptance';
const WS_OTHER = 'ws_li_multiseat_acceptance_other';
/** A Monday, 09:00 UTC, inside both seats' 08:00-18:00 UTC working window. */
const NOW = new Date('2026-08-03T09:00:00.000Z');
/** The next business morning: every slot the Monday tick paced is due by then. */
const TUESDAY = new Date('2026-08-04T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T09:00:00.000Z');
const HOUR = 3_600_000;

const page = {} as LinkedInPage;
const noSleep = async () => {};

const seatRead: LinkedInSeatRead = {
  ok: true,
  profileUrl: 'https://www.linkedin.com/in/multi-seat/',
  name: 'Multi Seat',
  connectionsCount: 100,
  degraded: []
};
const ok: LinkedInDriverResult = { ok: true, failureKind: null };

/** Records every call the batch makes; answers success. Copied from local-worker.test.ts. */
function fakeDriver() {
  const calls: Array<{ method: string; target: string; body?: string }> = [];
  const record = (method: string, target: string, body?: string) => {
    calls.push({ method, target, ...(body === undefined ? {} : { body }) });
    return ok;
  };
  const driver: LinkedInDriver = {
    readSeat: async () => {
      calls.push({ method: 'readSeat', target: 'me' });
      return seatRead;
    },
    sendInvite: async (_page, target, note) => record('sendInvite', target, note),
    sendDm: async (_page, target, body) => record('sendDm', target, body),
    sendReply: async (_page, threadUrn, body) => record('sendReply', threadUrn, body),
    viewProfile: async (_page, target) => record('viewProfile', target),
    followProfile: async (_page, target) => record('followProfile', target),
    unfollowProfile: async (_page, target) => record('unfollowProfile', target),
    disconnectProfile: async (_page, target) => record('disconnectProfile', target),
    followCompany: async (_page, companyUrl) => record('followCompany', companyUrl),
    likeCompanyRecentPost: async (_page, companyUrl) => record('likeCompanyRecentPost', companyUrl),
    inviteConnectionToFollowCompany: async (_page, target) =>
      record('inviteConnectionToFollowCompany', target),
    inviteConnectionToEvent: async (_page, target) => record('inviteConnectionToEvent', target),
    inviteConnectionToGroup: async (_page, target) => record('inviteConnectionToGroup', target),
    messageGroupMember: async (_page, target) => record('messageGroupMember', target),
    messageEventAttendee: async (_page, target) => record('messageEventAttendee', target),
    likeRecentPost: async (_page, target) => record('likeRecentPost', target),
    endorseSkills: async (_page, target) => record('endorseSkills', target),
    isLoggedIn: async () => true,
    loginWithCredentials: async () => {
      throw new Error('no test in this file signs a browser in');
    }
  };
  return { driver, calls };
}

/** The production batch wiring: the real policy gate and the real safety gate, per action. */
function realGates(db: Db, at: Date) {
  return {
    page,
    sleep: noSleep,
    log: () => {},
    now: () => at,
    authorizeAction: (action: DueLinkedInAction) =>
      linkedinActionPolicyGate(db, action.workspaceId, action.id, {
        kind: action.kind,
        seatKey: action.seatKey,
        targetRef: action.targetRef,
        body: action.body,
        subject: action.subject,
        threadUrn: action.threadUrn,
        attachment: action.attachment,
        channelMetadata: action.channelMetadata
      }),
    evaluate: (action: DueLinkedInAction, now: Date) =>
      evaluateLinkedInSafety(
        db,
        {
          workspaceId: action.workspaceId,
          seatKey: action.seatKey,
          kind: action.kind as PacedKind,
          targetRef: action.targetRef,
          plannedFor: now.toISOString(),
          ...(action.campaignId ? { campaignId: action.campaignId } : {}),
          ...(action.replayScope ? { replayScope: action.replayScope } : {})
        },
        now,
        { excludeActionId: action.id }
      )
  };
}

function summary(overrides: Partial<LinkedInThreadSummary> = {}): LinkedInThreadSummary {
  return {
    threadUrn: '2-shared==',
    profileUrl: 'https://www.linkedin.com/in/maya/',
    name: 'Maya Chen',
    lastMessageAt: '2026-08-03T08:30:00.000Z',
    snippet: 'Thanks for reaching out',
    unread: true,
    ...overrides
  };
}

/* ------------------------------------------------------------------------
 * Database-level isolation: campaigns, the worker claim, ceilings, threads,
 * credentials and sessions.
 * ---------------------------------------------------------------------- */
describe.skipIf(!databaseUrl)('TRV-044 multi-seat isolation (database)', () => {
  let db: Db;

  async function seat(workspaceId: string, seatKey: string, label: string) {
    await upsertSeat(
      db,
      workspaceId,
      {
        label,
        timezone: 'UTC',
        workingDays: [1, 2, 3, 4, 5],
        workStartMinute: 480,
        workEndMinute: 1080,
        // Established accounts: the cold-account day-over-day ramp is not what
        // these tests are about, and the rolling ceilings still apply.
        warmupOverride: true
      },
      LONG_AGO,
      seatKey
    );
  }

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    resetLinkedInSessionRhythm();
    for (const workspaceId of [WS, WS_OTHER]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db
        .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
        .run(workspaceId, 'TRV-044 multi-seat acceptance', LONG_AGO.toISOString());
    }
    await seat(WS, 'owner', 'Founder');
    await seat(WS, 'sales', 'Sales');
  });

  afterEach(async () => {
    for (const workspaceId of [WS, WS_OTHER])
      await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db?.close();
  });

  async function list(seatKey: string, name: string, slugs: string[]): Promise<string> {
    const made = await createLeadList(db, { workspaceId: WS, seatKey, name }, NOW);
    const csv = [
      'First Name,Last Name,Company,Email,LinkedIn URL',
      ...slugs.map(
        (slug) => `${slug},Lead,Acme,${slug}@multiseat.test,https://www.linkedin.com/in/${slug}`
      )
    ].join('\n');
    const imported = await importLeadCsv(
      db,
      { workspaceId: WS, seatKey, listId: made.id, csv },
      NOW
    );
    expect(imported.inserted).toBe(slugs.length);
    return made.id;
  }

  async function campaign(
    name: string,
    senderKeys: string[],
    slugs: string[],
    workflowId: string
  ): Promise<string> {
    const leadListId = await list(senderKeys[0]!, `${name} leads`, slugs);
    const made = await createManagedCampaign(
      db,
      { workspaceId: WS, name, leadListId, workflowId, senderKeys },
      NOW
    );
    await startManagedCampaign(db, WS, made.campaign.id, NOW);
    return made.campaign.id;
  }

  interface LedgerRow {
    id: string;
    seat_key: string;
    kind: string;
    status: string;
    target_ref: string;
    claimed_at: string | null;
    member_id: string;
    assigned_seat_key: string | null;
    campaign_id: string;
    sender_keys: string[];
  }

  async function ledger(): Promise<LedgerRow[]> {
    return db
      .prepare(
        `
      SELECT a.id, a.seat_key, a.kind, a.status, a.target_ref, a.claimed_at::text AS claimed_at,
             m.id AS member_id, m.assigned_seat_key, c.id AS campaign_id, c.sender_keys_json AS sender_keys
      FROM linkedin_actions a
      JOIN linkedin_campaign_members m ON m.workspace_id=a.workspace_id AND m.id=a.campaign_member_id
      JOIN linkedin_campaigns c ON c.workspace_id=m.workspace_id AND c.id=m.campaign_id
      WHERE a.workspace_id=?
      ORDER BY a.id
    `
      )
      .all<LedgerRow>(WS);
  }

  async function assignments(campaignIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const campaignId of campaignIds)
      for (const member of await listCampaignMembers(db, WS, campaignId))
        out.set(member.id, member.assignedSeatKey);
    return out;
  }

  it('executes a campaign bound to one seat only on that seat, and never moves a member to another seat', async () => {
    const workflow = await saveWorkflow(
      db,
      {
        workspaceId: WS,
        name: 'View then follow',
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          },
          { id: 'follow', action: 'follow', delayBefore: { amount: 0, unit: 'hours' }, config: {} }
        ]
      },
      NOW
    );
    const ownerOnly = await campaign('Owner only', ['owner'], ['x-one', 'x-two'], workflow.id);
    const salesOnly = await campaign('Sales only', ['sales'], ['y-one', 'y-two'], workflow.id);
    const pooled = await campaign(
      'Pooled',
      ['owner', 'sales'],
      ['z-one', 'z-two', 'z-three', 'z-four'],
      workflow.id
    );
    const campaigns = [ownerOnly, salesOnly, pooled];

    await runManagedCampaigns(db, WS, NOW);
    const planned = await ledger();
    expect(planned).toHaveLength(8);
    // THE BINDING: every ledger row is filed on its member's sticky seat, and
    // that seat is in its campaign's sender pool.
    for (const row of planned) {
      expect(row.seat_key).toBe(row.assigned_seat_key);
      expect(row.sender_keys).toContain(row.seat_key);
      expect(row.status).toBe('planned');
    }
    expect(
      new Set(planned.filter((r) => r.campaign_id === ownerOnly).map((r) => r.seat_key))
    ).toEqual(new Set(['owner']));
    expect(
      new Set(planned.filter((r) => r.campaign_id === salesOnly).map((r) => r.seat_key))
    ).toEqual(new Set(['sales']));
    // The pool rotates across both accounts rather than piling onto one.
    expect(new Set(planned.filter((r) => r.campaign_id === pooled).map((r) => r.seat_key))).toEqual(
      new Set(['owner', 'sales'])
    );
    const assignedBefore = await assignments(campaigns);

    const salesTargets = planned
      .filter((r) => r.seat_key === 'sales')
      .map((r) => r.target_ref)
      .sort();
    const ownerTargets = planned
      .filter((r) => r.seat_key === 'owner')
      .map((r) => r.target_ref)
      .sort();
    expect(salesTargets.length).toBeGreaterThan(0);
    expect(ownerTargets.length).toBeGreaterThan(0);

    // The sales account's worker drains the sales rows and nothing else.
    const salesRun = fakeDriver();
    const sales = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'sales'), {
      driver: salesRun.driver,
      ...realGates(db, TUESDAY)
    });
    expect(sales).toMatchObject({ seatKey: 'sales', halted: false, executed: salesTargets.length });
    expect(
      salesRun.calls
        .filter((call) => call.method === 'viewProfile')
        .map((call) => call.target)
        .sort()
    ).toEqual(salesTargets);
    const afterSales = await ledger();
    for (const row of afterSales.filter((r) => r.seat_key === 'owner')) {
      // Untouched: still planned and unclaimed, waiting for its own account.
      expect(row.status).toBe('planned');
      expect(row.claimed_at).toBeNull();
    }
    expect(afterSales.filter((r) => r.seat_key === 'sales').every((r) => r.status === 'sent')).toBe(
      true
    );

    // And the owner's worker then drains exactly the owner rows.
    const ownerRun = fakeDriver();
    const owner = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'owner'), {
      driver: ownerRun.driver,
      ...realGates(db, TUESDAY)
    });
    expect(owner).toMatchObject({ seatKey: 'owner', halted: false, executed: ownerTargets.length });
    expect(
      ownerRun.calls
        .filter((call) => call.method === 'viewProfile')
        .map((call) => call.target)
        .sort()
    ).toEqual(ownerTargets);
    expect((await ledger()).every((r) => r.status === 'sent')).toBe(true);

    // PAUSE THE OWNER ACCOUNT. Its members stop where they are; none of them is
    // handed to the sales account, and the sales account carries on.
    await upsertSeat(db, WS, { posture: 'paused' }, TUESDAY, 'owner');
    await runManagedCampaigns(db, WS, new Date(TUESDAY.getTime() + HOUR));
    const afterPause = await ledger();
    for (const row of afterPause) {
      expect(row.seat_key).toBe(row.assigned_seat_key);
      expect(row.sender_keys).toContain(row.seat_key);
    }
    const follows = afterPause.filter((r) => r.kind === 'follow');
    expect(follows.length).toBeGreaterThan(0);
    expect(follows.every((r) => r.seat_key === 'sales')).toBe(true);
    const ownerMembers = [...assignedBefore].filter(([, seatKey]) => seatKey === 'owner');
    expect(ownerMembers.length).toBe(ownerTargets.length);
    expect(
      follows.filter((r) => ownerMembers.some(([memberId]) => memberId === r.member_id))
    ).toEqual([]);
    expect(await assignments(campaigns)).toEqual(assignedBefore);

    // The owner's worker refuses to act at all while its account is paused.
    const pausedRun = fakeDriver();
    const paused = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'owner'), {
      driver: pausedRun.driver,
      ...realGates(db, new Date(TUESDAY.getTime() + 2 * HOUR))
    });
    expect(paused.executed).toBe(0);
    expect(pausedRun.calls.filter((call) => call.method !== 'isLoggedIn')).toEqual([]);
  });

  it("fills one seat's rolling-24h invite ceiling without touching the other's", async () => {
    await upsertSeat(db, WS, { dailyInviteLimit: 3 }, LONG_AGO, 'owner');
    await upsertSeat(db, WS, { dailyInviteLimit: 3 }, LONG_AGO, 'sales');
    const at = new Date('2026-08-04T10:00:00.000Z');
    for (const n of [1, 2, 3]) {
      await recordAction(
        db,
        {
          workspaceId: WS,
          seatKey: 'owner',
          kind: 'invite',
          targetRef: `https://www.linkedin.com/in/filled-${n}/`,
          status: 'sent',
          source: 'export'
        },
        new Date(at.getTime() - n * HOUR)
      );
    }
    const ask = (seatKey: string) =>
      evaluateLinkedInSafety(
        db,
        {
          workspaceId: WS,
          seatKey,
          kind: 'invite',
          targetRef: 'https://www.linkedin.com/in/next-invitee/',
          plannedFor: at.toISOString()
        },
        at
      );
    const full = await ask('owner');
    expect(full.allowed).toBe(false);
    expect(full.checks.find((check) => check.check === 'rolling-24h')?.passed).toBe(false);

    const free = await ask('sales');
    expect(free.checks.find((check) => check.check === 'rolling-24h')?.passed).toBe(true);
    expect(free.allowed).toBe(true);

    // Same seat key, another workspace: its own empty ledger.
    await upsertSeat(
      db,
      WS_OTHER,
      { label: 'Other founder', timezone: 'UTC', dailyInviteLimit: 3, warmupOverride: true },
      LONG_AGO,
      'owner'
    );
    const otherTenant = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WS_OTHER,
        seatKey: 'owner',
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/next-invitee/',
        plannedFor: at.toISOString()
      },
      at
    );
    expect(otherTenant.checks.find((check) => check.check === 'rolling-24h')?.passed).toBe(true);
  });

  it("keeps one LinkedIn thread id as two seats' separate conversations", async () => {
    const OWNER_LEAD = 'https://www.linkedin.com/in/maya/';
    const SALES_LEAD = 'https://www.linkedin.com/in/sales-lead/';
    await syncThreads(
      db,
      {
        workspaceId: WS,
        seatKey: 'owner',
        threads: [
          summary({ profileUrl: OWNER_LEAD }),
          summary({ threadUrn: '2-owner-only==', profileUrl: 'https://www.linkedin.com/in/o/' })
        ]
      },
      NOW
    );
    await syncThreads(
      db,
      { workspaceId: WS, seatKey: 'sales', threads: [summary({ profileUrl: SALES_LEAD })] },
      NOW
    );

    const rows = await db
      .prepare(
        'SELECT seat_key, profile_url FROM linkedin_threads WHERE workspace_id=? AND thread_urn=? ORDER BY seat_key'
      )
      .all<{ seat_key: string; profile_url: string }>(WS, '2-shared==');
    expect(rows).toEqual([
      { seat_key: 'owner', profile_url: OWNER_LEAD },
      { seat_key: 'sales', profile_url: SALES_LEAD }
    ]);

    expect(
      (await listThreads(db, WS, { seatKey: 'sales' })).map((t) => [t.threadUrn, t.seatKey])
    ).toEqual([['2-shared==', 'sales']]);
    expect(
      (await listThreads(db, WS, { seatKey: 'owner' })).map((t) => t.threadUrn).sort()
    ).toEqual(['2-owner-only==', '2-shared==']);
    expect(await threadByUrn(db, WS, '2-owner-only==', 'sales')).toBeUndefined();
    expect(await threadByUrn(db, WS_OTHER, '2-shared==', 'owner')).toBeUndefined();

    // A reply from the sales account into a conversation only the owner has is
    // NOT FOUND, and files nothing.
    await expect(
      enqueueReply(
        db,
        { workspaceId: WS, seatKey: 'sales', threadUrn: '2-owner-only==', body: 'hello' },
        NOW
      )
    ).rejects.toMatchObject({ status: 404 });
    const count = async () =>
      (
        await db
          .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
          .get<{ total: number }>(WS)
      )?.total;
    expect(await count()).toBe(0);

    // Its own copy of the shared id answers its own lead, from its own account.
    const queued = await enqueueReply(
      db,
      { workspaceId: WS, seatKey: 'sales', threadUrn: '2-shared==', body: 'hello' },
      NOW
    );
    const row = await db
      .prepare('SELECT seat_key, target_ref, thread_urn FROM linkedin_actions WHERE id=?')
      .get<{ seat_key: string; target_ref: string; thread_urn: string }>(queued.actionId);
    expect(row).toEqual({ seat_key: 'sales', target_ref: SALES_LEAD, thread_urn: '2-shared==' });
  });

  it("never opens one seat's stored sign-in or browser session as another seat's", async () => {
    const previousKey = process.env.TREVRA_SECRETS_KEY;
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TREVRA_DEPLOYMENT_MODE: 'local',
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/'
    };
    try {
      await seat(WS, 'growth', 'Growth');
      const ownerPair = { email: 'owner@multiseat.test', password: 'owner-secret-1' };
      const salesPair = { email: 'sales@multiseat.test', password: 'sales-secret-2' };
      await putLinkedInCredentials(db, { workspaceId: WS, seatKey: 'owner', env, ...ownerPair });
      await putLinkedInCredentials(db, { workspaceId: WS, seatKey: 'sales', env, ...salesPair });

      expect(await readLinkedInCredentials(db, WS, env, 'owner')).toEqual(ownerPair);
      expect(await readLinkedInCredentials(db, WS, env, 'sales')).toEqual(salesPair);
      expect(await readLinkedInCredentials(db, WS, env, 'growth')).toBeNull();
      expect(await readLinkedInCredentials(db, WS_OTHER, env, 'sales')).toBeNull();
      expect(await readLinkedInCredentials(db, WS_OTHER, env, 'owner')).toBeNull();

      // A transplant: the sales seat's sealed rows relabelled as the growth
      // seat's. The seat is in the AAD, so they must not open as growth.
      await db
        .prepare(
          "UPDATE linkedin_seat_credentials SET seat_key='growth' WHERE workspace_id=? AND seat_key='sales'"
        )
        .run(WS);
      const transplanted = await readLinkedInCredentials(db, WS, env, 'growth').catch(() => null);
      expect(transplanted).toBeNull();
      expect(await readLinkedInCredentials(db, WS, env, 'sales')).toBeNull();

      const state = {
        cookies: [
          {
            name: 'li_at',
            value: 'sales-session-canary',
            domain: '.linkedin.com',
            path: '/',
            expires: 2_000_000_000,
            httpOnly: true,
            secure: true
          }
        ],
        origins: []
      };
      expect(
        await saveSeatStorageState(db, { workspaceId: WS, seatKey: 'sales', state, env, now: NOW })
      ).toBe(true);
      expect((await readSeatStorageState(db, WS, 'sales', { env, now: NOW })).status).toBe('ok');
      expect((await readSeatStorageState(db, WS, 'owner', { env, now: NOW })).status).toBe(
        'absent'
      );
      expect((await readSeatStorageState(db, WS_OTHER, 'sales', { env, now: NOW })).status).toBe(
        'absent'
      );
      await db
        .prepare(
          "UPDATE linkedin_seat_sessions SET seat_key='growth' WHERE workspace_id=? AND seat_key='sales'"
        )
        .run(WS);
      const moved = await readSeatStorageState(db, WS, 'growth', { env, now: NOW });
      expect(moved.status).toBe('needs_login');
      expect(JSON.stringify(moved)).not.toContain('sales-session-canary');
    } finally {
      if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
      else process.env.TREVRA_SECRETS_KEY = previousKey;
    }
  });

  it("never lets one workspace's worker claim another workspace's rows under the same seat key", async () => {
    await seat(WS_OTHER, 'owner', 'Other founder');
    // Very old slots, so these two seats sort first in a shared test database.
    const due = new Date('2021-01-04T10:00:00.000Z');
    for (const [workspaceId, id] of [
      [WS, 'lact_multiseat_ws_a'],
      [WS_OTHER, 'lact_multiseat_ws_b']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at)
           VALUES (?,?,'owner','profile_view',?,'planned',?,'export',?)`
        )
        .run(
          id,
          workspaceId,
          `https://www.linkedin.com/in/${id}/`,
          due.toISOString(),
          due.toISOString()
        );
    }

    const seats = (await dueSeatsForWorker(db, NOW, { seatKey: 'owner' })).filter(
      (s) => s.workspaceId === WS || s.workspaceId === WS_OTHER
    );
    expect(seats.map((s) => `${s.workspaceId}/${s.seatKey}`).sort()).toEqual([
      `${WS}/owner`,
      `${WS_OTHER}/owner`
    ]);

    const mine = postgresLocalWorkerStore(db, WS, 'owner');
    const batch = await mine.openBatch(TUESDAY);
    expect((await mine.claimNextDueAction(batch, TUESDAY))?.id).toBe('lact_multiseat_ws_a');
    expect(await mine.claimNextDueAction(batch, TUESDAY)).toBeNull();
    await mine.releaseClaim('lact_multiseat_ws_a', null);

    // A full batch for workspace A touches only workspace A's target.
    const run = fakeDriver();
    const result = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'owner'), {
      driver: run.driver,
      ...realGates(db, TUESDAY)
    });
    expect(result.workspaceId).toBe(WS);
    expect(run.calls.filter((c) => c.method === 'viewProfile').map((c) => c.target)).toEqual([
      'https://www.linkedin.com/in/lact_multiseat_ws_a/'
    ]);
    const other = await db
      .prepare('SELECT status, claimed_at FROM linkedin_actions WHERE workspace_id=? AND id=?')
      .get<{ status: string; claimed_at: string | null }>(WS_OTHER, 'lact_multiseat_ws_b');
    expect(other).toEqual({ status: 'planned', claimed_at: null });
  });
});

/* ------------------------------------------------------------------------
 * Browser handles: closing one workspace must not close another's.
 * ---------------------------------------------------------------------- */
describe('TRV-044 browser handles are per (workspace, seat)', () => {
  function fakeCompanion() {
    const opened: string[] = [];
    const closed: string[] = [];
    let next = 0;
    const labels: string[] = [];
    const playwright = {
      chromium: {
        launchPersistentContext: async () => {
          throw new Error('server-local Chromium must never launch');
        },
        connectOverCDP: async () => {
          const label = labels[next++] ?? `unknown-${next}`;
          opened.push(label);
          const context = {
            pages: () => [{}],
            newPage: async () => ({}),
            on: () => {},
            storageState: async () => ({ cookies: [], origins: [] }),
            close: async () => {}
          };
          return {
            contexts: () => [context],
            newContext: async () => {
              throw new Error('Companion must use its existing persistent context');
            },
            close: async () => {
              closed.push(label);
            }
          };
        }
      }
    } as unknown as PlaywrightLike;
    return { playwright, opened, closed, expect: (label: string) => labels.push(label) };
  }

  const config = {
    enabled: true,
    hosted: false,
    profileDir: null,
    remoteBrowser: false,
    companionBrowser: true
  };
  const env = {
    TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080',
    TREVRA_SECRETS_KEY: 'companion-test-secret'
  };

  afterEach(async () => {
    await closeLinkedInBrowser();
  });

  it('closes only the named workspace, even when another id starts with the same characters', async () => {
    const fake = fakeCompanion();
    const open = (workspaceId: string) =>
      openBrowser(config, () => {}, {
        db: null,
        workspaceId,
        seatKey: 'owner',
        headless: true,
        env,
        playwright: fake.playwright
      });
    fake.expect('ws_1/owner');
    expect(await open('ws_1')).not.toBeNull();
    fake.expect('ws_10/owner');
    expect(await open('ws_10')).not.toBeNull();
    expect(fake.opened).toEqual(['ws_1/owner', 'ws_10/owner']);

    await closeLinkedInBrowser('ws_1');
    expect(fake.closed).toEqual(['ws_1/owner']);

    // ws_10's handle is still live and is reused, not reopened.
    expect(await open('ws_10')).not.toBeNull();
    expect(fake.opened).toEqual(['ws_1/owner', 'ws_10/owner']);
  });
});

/* ------------------------------------------------------------------------
 * Over HTTP with real Better Auth roles: assignment, use, replies, limits.
 * ---------------------------------------------------------------------- */
describe.skipIf(!databaseUrl)('TRV-044 seat ownership over HTTP (TRV-045 roles)', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let seq = 0;

  beforeAll(async () => {
    await migrateAuthDatabase();
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    app = createApp(db);
  });
  afterAll(async () => {
    await db?.close();
    await closeAuthDatabase();
  });

  type Person = Awaited<ReturnType<typeof signUp>>;

  async function signUp(label: string) {
    seq += 1;
    const agent = request.agent(app);
    const email = `${label}-${Date.now()}-${seq}@multi-seat.test`;
    const res = await agent
      .post('/api/auth/sign-up/email')
      .send({ email, password: 'correct-horse-battery-staple', name: label })
      .expect(200);
    const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
      userId: string;
      workspaceId: string;
      role: WorkspaceRole;
    };
    return { agent, email, authUserId: res.body.user.id as string, auth };
  }

  async function join(person: Person, workspaceId: string, role: WorkspaceRole) {
    await betterAuth.api.addMember({
      body: { userId: person.authUserId, organizationId: workspaceId, role }
    });
    await person.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: workspaceId })
      .expect(200);
    const auth = (await person.agent.get('/api/auth/session').expect(200)).body.auth;
    expect(auth).toMatchObject({ role, workspaceId });
    person.auth = auth;
  }

  async function team() {
    const owner = await signUp('owner');
    const manager = await signUp('manager');
    const member = await signUp('member');
    const teammate = await signUp('teammate');
    await join(manager, owner.auth.workspaceId, 'manager');
    await join(member, owner.auth.workspaceId, 'member');
    await join(teammate, owner.auth.workspaceId, 'member');
    return { owner, manager, member, teammate, workspaceId: owner.auth.workspaceId };
  }

  async function actionCount(workspaceId: string): Promise<number> {
    const row = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(workspaceId);
    return row?.total ?? 0;
  }

  it('lets owner and manager assign a seat, refuses a member or a stranger, and really unassigns', async () => {
    const { owner, manager, member, teammate, workspaceId } = await team();
    const stranger = await signUp('stranger');
    await owner.agent
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'sales', label: 'Sales', timezone: 'UTC' })
      .expect(201);
    const assign = (person: Person, ownerUserId: string | null, seatKey = 'sales') =>
      person.agent.patch(`/api/linkedin/manager/seats/${seatKey}`).send({ ownerUserId });

    expect((await assign(owner, member.auth.userId).expect(200)).body.seat.ownerUserId).toBe(
      member.auth.userId
    );
    expect((await assign(manager, teammate.auth.userId).expect(200)).body.seat.ownerUserId).toBe(
      teammate.auth.userId
    );
    // The Better Auth id resolves to the same Trevra user.
    expect((await assign(manager, member.authUserId).expect(200)).body.seat.ownerUserId).toBe(
      member.auth.userId
    );
    // Assignment only: a manager may not ride a limit change in on it.
    await manager.agent
      .patch('/api/linkedin/manager/seats/sales')
      .send({ ownerUserId: manager.auth.userId, dailyInviteLimit: 5 })
      .expect(403);
    await assign(member, member.auth.userId).expect(403);
    await assign(teammate, teammate.auth.userId).expect(403);
    await assign(owner, stranger.auth.userId).expect(400);
    await assign(owner, member.auth.userId, 'no-such-seat').expect(404);
    expect((await getSeat(db, workspaceId, 'sales'))?.ownerUserId).toBe(member.auth.userId);

    // An unrelated owner edit keeps the assignment.
    await owner.agent
      .patch('/api/linkedin/manager/seats/sales')
      .send({ label: 'Sales (renamed)' })
      .expect(200);
    expect((await getSeat(db, workspaceId, 'sales'))?.ownerUserId).toBe(member.auth.userId);

    // Unassigning is a real write, not a 200 that keeps the old owner.
    expect((await assign(manager, null).expect(200)).body.seat.ownerUserId).toBeNull();
    expect((await getSeat(db, workspaceId, 'sales'))?.ownerUserId).toBeNull();
  });

  it("cannot address another workspace's seat, even under the same seat key", async () => {
    const { owner, member, workspaceId } = await team();
    const otherOwner = await signUp('other-owner');
    const otherWorkspace = otherOwner.auth.workspaceId;
    for (const seatKey of ['sales', 'growth']) {
      await otherOwner.agent
        .post('/api/linkedin/manager/seats')
        .send({ seatKey, label: `Other ${seatKey}`, timezone: 'UTC' })
        .expect(201);
    }
    await owner.agent
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'sales', label: 'Sales', timezone: 'UTC' })
      .expect(201);

    // 'growth' exists only in the other workspace.
    await owner.agent
      .patch('/api/linkedin/manager/seats/growth')
      .send({ ownerUserId: member.auth.userId })
      .expect(404);
    // 'sales' exists in both; only this workspace's row moves.
    await owner.agent
      .patch('/api/linkedin/manager/seats/sales')
      .send({ ownerUserId: member.auth.userId })
      .expect(200);
    expect((await getSeat(db, workspaceId, 'sales'))?.ownerUserId).toBe(member.auth.userId);
    expect((await getSeat(db, otherWorkspace, 'sales'))?.ownerUserId).toBe(otherOwner.auth.userId);
    expect((await getSeat(db, otherWorkspace, 'growth'))?.ownerUserId).toBe(otherOwner.auth.userId);
    // And the other owner cannot hand their seat to somebody outside their workspace.
    await otherOwner.agent
      .patch('/api/linkedin/manager/seats/sales')
      .send({ ownerUserId: member.auth.userId })
      .expect(400);
    // Reads are workspace-scoped too.
    const listed = (await owner.agent.get('/api/linkedin/manager/seats').expect(200)).body
      .seats as Array<{ seatKey: string; workspaceId: string }>;
    expect(listed.every((s) => s.workspaceId === workspaceId)).toBe(true);
    expect(listed.map((s) => s.seatKey)).not.toContain('growth');
  });

  it('lets only the assigned teammate (or a manager) run campaigns on a seat, and unassigning revokes it', async () => {
    const { owner, manager, member, teammate } = await team();
    await owner.agent
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'sales', label: 'Sales', timezone: 'UTC', ownerUserId: member.auth.userId })
      .expect(201);

    const list = (
      await member.agent
        .post('/api/linkedin/manager/lead-lists')
        .send({ seatKey: 'sales', name: 'Member leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    const workflow = (
      await member.agent
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'Member flow',
          scope: 'personal',
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
    const create = (person: Person, name: string) =>
      person.agent
        .post('/api/linkedin/manager/campaigns')
        .send({ name, seatKey: 'sales', leadListId: list.id, workflowId: workflow.id });

    const mine = (await create(member, 'Assigned sender').expect(201)).body.campaign;
    expect(mine.senderKeys).toEqual(['sales']);
    await member.agent
      .post(`/api/linkedin/manager/campaigns/${mine.id}/start`)
      .send({})
      .expect(200);
    await create(teammate, 'Not my account').expect(403);
    await create(manager, 'Manager may use any seat').expect(201);

    // Unassign, and the member's own access to the account goes with it.
    await owner.agent
      .patch('/api/linkedin/manager/seats/sales')
      .send({ ownerUserId: null })
      .expect(200);
    await create(member, 'After unassign').expect(403);
  });

  it('refuses a reply from a seat assigned to another teammate, and files nothing', async () => {
    const { owner, manager, member, teammate, workspaceId } = await team();
    for (const [seatKey, label, ownerUserId] of [
      ['owner', 'Founder', owner.auth.userId],
      ['sales', 'Sales', member.auth.userId]
    ] as const) {
      await upsertSeat(
        db,
        workspaceId,
        { label, timezone: 'UTC', ownerUserId, warmupOverride: true },
        LONG_AGO,
        seatKey
      );
    }
    const now = new Date();
    await syncThreads(
      db,
      {
        workspaceId,
        seatKey: 'sales',
        threads: [
          summary({ threadUrn: '2-sales-a==', profileUrl: 'https://www.linkedin.com/in/sales-a/' }),
          summary({ threadUrn: '2-sales-b==', profileUrl: 'https://www.linkedin.com/in/sales-b/' })
        ]
      },
      now
    );
    await syncThreads(
      db,
      {
        workspaceId,
        seatKey: 'owner',
        threads: [
          summary({ threadUrn: '2-owner==', profileUrl: 'https://www.linkedin.com/in/owner-lead/' })
        ]
      },
      now
    );
    const reply = (person: Person, threadUrn: string, seatKey?: string) =>
      person.agent
        .post(`/api/linkedin/inbox/threads/${encodeURIComponent(threadUrn)}/reply`)
        .send({ body: `Reply from ${person.email}`, ...(seatKey ? { seatKey } : {}) });

    // A teammate who does not hold the sales account cannot answer from it.
    await reply(teammate, '2-sales-a==', 'sales').expect(403);
    // Nor from the founder's account, which is the default seat.
    await reply(teammate, '2-owner==').expect(403);
    await reply(member, '2-owner==').expect(403);
    expect(await actionCount(workspaceId)).toBe(0);

    // The assigned teammate can; a conversation the sales account does not
    // have is still NOT FOUND for it.
    const queued = (await reply(member, '2-sales-a==', 'sales').expect(201)).body;
    await reply(member, '2-owner==', 'sales').expect(404);
    // A manager can use any seat; so can the owner.
    await reply(manager, '2-sales-b==', 'sales').expect(201);
    await reply(owner, '2-owner==').expect(201);

    const rows = await db
      .prepare(
        'SELECT id, seat_key, thread_urn, queued_by_user_id FROM linkedin_actions WHERE workspace_id=? ORDER BY thread_urn'
      )
      .all<{ id: string; seat_key: string; thread_urn: string; queued_by_user_id: string }>(
        workspaceId
      );
    expect(rows.map((r) => [r.thread_urn, r.seat_key, r.queued_by_user_id])).toEqual([
      ['2-owner==', 'owner', owner.auth.userId],
      ['2-sales-a==', 'sales', member.auth.userId],
      ['2-sales-b==', 'sales', manager.auth.userId]
    ]);
    expect(rows.find((r) => r.thread_urn === '2-sales-a==')?.id).toBe(queued.actionId);

    // Reading the shared inbox stays open to every role.
    const threads = (
      await teammate.agent
        .get('/api/linkedin/inbox/threads')
        .query({ seatKey: 'sales' })
        .expect(200)
    ).body.threads as Array<{ threadUrn: string }>;
    expect(threads.map((t) => t.threadUrn).sort()).toEqual(['2-sales-a==', '2-sales-b==']);
    await teammate.agent
      .get(`/api/linkedin/inbox/threads/${encodeURIComponent('2-sales-a==')}`)
      .query({ seatKey: 'sales' })
      .expect(200);
    await teammate.agent
      .get(`/api/linkedin/inbox/threads/${encodeURIComponent('2-sales-a==')}`)
      .query({ seatKey: 'owner' })
      .expect(404);
  });

  it('reports each seat its own used counts on the limits route', async () => {
    const { owner, member, workspaceId } = await team();
    for (const seatKey of ['owner', 'sales']) {
      await upsertSeat(
        db,
        workspaceId,
        { label: seatKey, timezone: 'UTC', warmupOverride: true },
        LONG_AGO,
        seatKey
      );
    }
    // The route reads the wall clock, so these are anchored to it.
    const now = Date.now();
    for (const [seatKey, n] of [
      ['owner', 1],
      ['owner', 2],
      ['owner', 3],
      ['sales', 1]
    ] as const) {
      await recordAction(
        db,
        {
          workspaceId,
          seatKey,
          kind: 'invite',
          targetRef: `https://www.linkedin.com/in/${seatKey}-${n}/`,
          status: 'sent',
          source: 'export'
        },
        new Date(now - n * HOUR)
      );
    }
    const usedToday = async (person: Person, seatKey: string) => {
      const body = (await person.agent.get('/api/linkedin/limits').query({ seatKey }).expect(200))
        .body as { limits: Array<{ kind: string; window: string; used: number }> };
      return body.limits.find((l) => l.kind === 'invite' && l.window === 'day')?.used;
    };
    expect(await usedToday(owner, 'owner')).toBe(3);
    expect(await usedToday(owner, 'sales')).toBe(1);
    expect(await usedToday(member, 'sales')).toBe(1);
    expect(await usedToday(owner, 'growth')).toBe(0);
  });
});
