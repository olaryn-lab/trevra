import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { id, openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import type { TodayItem } from '../today.js';
import { linkedinActionPolicyGate, reviewLinkedInAction } from './action-policy.js';
import { linkedinAnalytics } from './action-ledger.js';
import type { LinkedInDriver, LinkedInDriverResult, LinkedInPage } from './driver.js';
import { evaluateLinkedInSafety, type LinkedInSafetyVerdict } from './guard.js';
import { listLinkedInHandoffs, presentLinkedInHandoffs } from './handoff.js';
import { editQueuedMessage } from './inbox.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  dueSeatsForWorker,
  postgresLocalWorkerStore,
  runLinkedInLocalBatch,
  seatsWithDueActions,
  type DueLinkedInAction,
  type LocalBatchDeps
} from './local-worker.js';
import {
  createManagedCampaign,
  managedAnalytics,
  startManagedCampaign
} from './managed-campaigns.js';
import { repReport } from './rep-reporting.js';
import { runManagedCampaigns } from './runner.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/* ---------------------------------------------------------------------------
 * TRV-043 ACCEPTANCE: HUMAN-SEND, END TO END, ON REAL POSTGRES.
 *
 * A seat in human-send mode never reaches the browser driver for an invite or
 * a message. Today hands the founder the exact stored bytes, frozen once they
 * have been shown. "Mark sent" records the outcome once, through the same
 * ledger columns an automated send writes, so analytics and the safety gate
 * cannot tell the two apart. Workspace policy `deny` is never handed over.
 *
 * No browser is launched and no provider is called: the driver is a recorder.
 * ------------------------------------------------------------------------ */

const WS = 'ws_human_send_acceptance';
const OTHER = 'ws_human_send_acceptance_other';
// A Tuesday, 10:00 UTC: inside the default 09:00-17:00 working window.
const NOW = new Date('2026-08-04T10:00:00.000Z');
const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
const MINUTE = 60_000;
/** Unicode, an em dash, an emoji, a newline and trailing spaces, as stored. */
const AWKWARD_NOTE = 'Hi {{first_name}} — ünïcødé ✓ 👋\nSecond line keeps its spaces   ';
const AWKWARD_DM =
  'Hallö Maya — danke! 🙏\n\n  Indented second paragraph.\t\nTrailing spaces stay   ';

let db: Db;
let app: Express;
let token = '';
let otherToken = '';

async function session(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, workspaceId, `${userId}@trevra.test`, workspaceId, NOW.toISOString());
  const raw = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(raw).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW.toISOString()
    );
  return raw;
}

function as(sessionToken: string) {
  const cookie = `trevra_session=${sessionToken}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie)
  };
}

/** The HTTP routes read `new Date()`; pin it for the duration of one exchange. */
async function atTime<T>(when: Date, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: when });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

async function todayHandoffs(sessionToken: string, when: Date): Promise<TodayItem[]> {
  const response = await atTime(when, () => as(sessionToken).get('/api/today').expect(200));
  return (response.body.needsAttention as TodayItem[]).filter(
    (item) => item.kind === 'linkedin_handoff_waiting'
  );
}

function resolveOver(sessionToken: string, actionId: string, resolution: 'sent' | 'skip') {
  return as(sessionToken).post(`/api/linkedin/handoffs/${actionId}/resolve`).send({ resolution });
}

interface ActionRow {
  id: string;
  seat_key: string;
  kind: string;
  status: string;
  body: string | null;
  subject: string | null;
  target_ref: string;
  campaign_id: string | null;
  campaign_member_id: string | null;
  planned_for: Date | string | null;
  recorded_at: Date | string | null;
  claimed_at: Date | string | null;
  handoff_presented_at: Date | string | null;
}

async function actionRow(actionId: string): Promise<ActionRow> {
  const row = await db
    .prepare(
      `SELECT id,seat_key,kind,status,body,subject,target_ref,campaign_id,campaign_member_id,
              planned_for,recorded_at,claimed_at,handoff_presented_at
       FROM linkedin_actions WHERE id=?`
    )
    .get<ActionRow>(actionId);
  if (!row) throw new Error(`no action ${actionId}`);
  return row;
}

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

async function plan(
  actionId: string,
  seatKey: string,
  kind: string,
  target: string,
  body: string | null,
  options: {
    source?: string;
    subject?: string | null;
    plannedFor?: Date;
    workspaceId?: string;
  } = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,subject,created_at)
       VALUES (?,?,?,?,?,'planned',?,?,?,?,?)`
    )
    .run(
      actionId,
      options.workspaceId ?? WS,
      seatKey,
      kind,
      target,
      (options.plannedFor ?? new Date(NOW.getTime() - MINUTE)).toISOString(),
      options.source ?? 'export',
      body,
      options.subject ?? null,
      NOW.toISOString()
    );
}

async function policy(
  effect: 'allow' | 'deny' | 'require_approval',
  pattern: string,
  priority = 100
) {
  await db
    .prepare(
      `INSERT INTO workspace_policies
         (id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'{}'::jsonb,TRUE,?::timestamptz,?::timestamptz)`
    )
    .run(
      id('pol'),
      WS,
      `${effect} ${pattern}`,
      priority,
      pattern,
      effect,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function markedSentEvents(actionId: string, workspaceId = WS) {
  const events = await listDomainEvents(db, workspaceId, {
    streamType: 'linkedin_action',
    streamId: actionId
  });
  return events.filter((event) => event.eventType === 'linkedin.handoff.marked_sent');
}

async function member(memberId: string) {
  return db
    .prepare(
      `SELECT status, step_index, current_step_id, completed_step_ids
       FROM linkedin_campaign_members WHERE workspace_id=? AND id=?`
    )
    .get<{
      status: string;
      step_index: number;
      current_step_id: string | null;
      completed_step_ids: string[];
    }>(WS, memberId);
}

const FIRST_NAMES = ['Maya', 'Jonas', 'Ava', 'Ben'];

/**
 * A real managed campaign on `seatKey`: workflow (invite with a note, then a
 * profile view a day later), lead list, CSV import, create, start. The
 * runner tick that plans its rows is left to the caller.
 */
async function campaignOn(seatKey: string, name: string, slugs: string[], note: string) {
  const workflow = await saveWorkflow(
    db,
    {
      workspaceId: WS,
      name: `${name} workflow`,
      steps: [
        {
          id: 'invite',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { variants: [{ id: 'note', body: note, weight: 100 }] }
        },
        {
          id: 'view',
          action: 'profile_view',
          delayBefore: { amount: 1, unit: 'days' },
          config: {}
        }
      ]
    },
    NOW
  );
  const list = await createLeadList(db, { workspaceId: WS, name: `${name} leads` }, NOW);
  const csv = [
    'First Name,Last Name,Company,Email,LinkedIn URL',
    ...slugs.map(
      (slug, index) =>
        `${FIRST_NAMES[index % FIRST_NAMES.length]},${slug},Acme,${slug}@test.test,https://www.linkedin.com/in/${slug}`
    )
  ].join('\n');
  expect((await importLeadCsv(db, { workspaceId: WS, listId: list.id, csv }, NOW)).inserted).toBe(
    slugs.length
  );
  const made = await createManagedCampaign(
    db,
    { workspaceId: WS, name, leadListId: list.id, workflowId: workflow.id, seatKey },
    NOW
  );
  await startManagedCampaign(db, WS, made.campaign.id, NOW);
  return made.campaign.id;
}

async function plannedInvites(campaignId: string): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,seat_key,kind,status,body,subject,target_ref,campaign_id,campaign_member_id,
              planned_for,recorded_at,claimed_at,handoff_presented_at
       FROM linkedin_actions
       WHERE workspace_id=? AND campaign_id=? AND kind='invite' AND status='planned'
       ORDER BY planned_for ASC, id ASC`
    )
    .all<ActionRow>(WS, campaignId);
}

/** The instant a planned row is due, and never before NOW. */
function dueAt(row: ActionRow, slack = MINUTE): Date {
  const planned = row.planned_for === null ? NOW.getTime() : new Date(row.planned_for).getTime();
  return new Date(Math.max(NOW.getTime(), planned) + slack);
}

function allowed(): LinkedInSafetyVerdict {
  return {
    allowed: true,
    reason: null,
    checks: [],
    automationMode: 'prepare-only',
    automationReason: 'test'
  };
}

const page = {} as LinkedInPage;

/** Records EVERY driver call, sends included, and answers success. */
function recordingDriver() {
  const calls: Array<{ method: string; target: string; body?: string | null }> = [];
  const done = (target: string): LinkedInDriverResult => ({
    ok: true,
    externalRef: target,
    failureKind: null
  });
  const record = async (method: string, target: string, body?: string | null) => {
    calls.push({ method, target, body });
    return done(target);
  };
  const driver: LinkedInDriver = {
    sendInvite: (_page, target, note) => record('sendInvite', target, note ?? null),
    sendDm: (_page, target, body) => record('sendDm', target, body),
    sendInMail: (_page, target, subject, body) =>
      record('sendInMail', target, `${subject}|${body}`),
    sendReply: (_page, threadUrn, body) => record('sendReply', threadUrn, body),
    viewProfile: (_page, target) => record('viewProfile', target),
    followProfile: (_page, target) => record('followProfile', target),
    unfollowProfile: (_page, target) => record('unfollowProfile', target),
    disconnectProfile: (_page, target) => record('disconnectProfile', target),
    messageGroupMember: (_page, target, groupUrl, body) =>
      record('messageGroupMember', target, `${groupUrl}|${body}`),
    messageEventAttendee: (_page, target, eventUrl, body) =>
      record('messageEventAttendee', target, `${eventUrl}|${body}`),
    likeRecentPost: (_page, target) => record('likeRecentPost', target),
    endorseSkills: (_page, target) => record('endorseSkills', target),
    readSeat: async () => {
      calls.push({ method: 'readSeat', target: 'me' });
      return done('me');
    },
    isLoggedIn: async () => {
      calls.push({ method: 'isLoggedIn', target: 'me' });
      return true;
    },
    loginWithCredentials: async () => {
      throw new Error('no test here stores a credential, so nothing may attempt a sign-in');
    }
  };
  return { driver, calls };
}

/** The production pre-send boundary, minus the browser: real gate, real policy gate. */
function productionDeps(
  driver: LinkedInDriver,
  at: Date,
  overrides: Partial<LocalBatchDeps> = {}
): LocalBatchDeps {
  return {
    driver,
    page,
    sleep: async () => {},
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
    evaluate: (action: DueLinkedInAction, when: Date) =>
      evaluateLinkedInSafety(
        db,
        {
          workspaceId: action.workspaceId,
          seatKey: action.seatKey,
          kind: action.kind as Parameters<typeof evaluateLinkedInSafety>[1]['kind'],
          targetRef: action.targetRef,
          plannedFor: when.toISOString(),
          ...(action.campaignId ? { campaignId: action.campaignId } : {}),
          ...(action.replayScope ? { replayScope: action.replayScope } : {}),
          ...(action.manual ? { manual: true } : {})
        },
        when,
        { excludeActionId: action.id }
      ),
    ...overrides
  };
}

const SEND_METHODS = new Set([
  'sendInvite',
  'sendDm',
  'sendInMail',
  'sendReply',
  'messageGroupMember',
  'messageEventAttendee'
]);

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  for (const workspaceId of [WS, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  token = await session(WS);
  otherToken = await session(OTHER);
  await upsertSeat(db, WS, { label: 'Founder', timezone: 'UTC', sendMode: 'human' }, LONG_AGO);
  await upsertSeat(db, OTHER, { label: 'Other', timezone: 'UTC', sendMode: 'human' }, LONG_AGO);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const workspaceId of [WS, OTHER])
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db?.close();
});

describe('TRV-043 human-send acceptance', () => {
  it('never calls the browser driver for a human-send seat; the same rows on an automated seat do', async () => {
    await upsertSeat(db, WS, { label: 'SDR', timezone: 'UTC' }, LONG_AGO, 'sdr');
    await plan('lact_hs_dm', 'owner', 'dm', 'https://www.linkedin.com/in/hs-dm/', AWKWARD_DM, {
      source: 'manual'
    });
    await plan('lact_hs_invite', 'owner', 'invite', 'https://www.linkedin.com/in/hs-invite/', null);
    await plan('lact_auto_dm', 'sdr', 'dm', 'https://www.linkedin.com/in/auto-dm/', AWKWARD_DM, {
      source: 'manual'
    });
    await plan(
      'lact_auto_invite',
      'sdr',
      'invite',
      'https://www.linkedin.com/in/auto-invite/',
      null
    );

    // Discovery never wakes a browser for the human seat.
    expect(
      (await seatsWithDueActions(db, NOW))
        .filter((seat) => seat.workspaceId === WS)
        .map((seat) => seat.seatKey)
    ).toEqual(['sdr']);
    expect(
      (await dueSeatsForWorker(db, NOW))
        .filter((seat) => seat.workspaceId === WS)
        .map((seat) => seat.seatKey)
    ).toEqual(['sdr']);

    // Even a batch opened straight against the human seat touches nothing.
    const human = recordingDriver();
    const humanRun = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'owner'), {
      driver: human.driver,
      page,
      sleep: async () => {},
      log: () => {},
      now: () => NOW,
      evaluate: async () => allowed()
    });
    expect(human.calls).toEqual([]);
    expect(humanRun.executed).toBe(0);
    for (const actionId of ['lact_hs_dm', 'lact_hs_invite']) {
      const row = await actionRow(actionId);
      expect(row.status).toBe('planned');
      expect(row.claimed_at).toBeNull();
      expect(row.recorded_at).toBeNull();
    }

    // Control: the automated seat with the same setup does reach the driver.
    const robot = recordingDriver();
    const robotRun = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'sdr'), {
      driver: robot.driver,
      page,
      sleep: async () => {},
      log: () => {},
      now: () => NOW,
      evaluate: async () => allowed()
    });
    expect(robotRun.executed).toBe(2);
    expect(
      robot.calls
        .filter((call) => SEND_METHODS.has(call.method))
        .map((call) => call.method)
        .sort()
    ).toEqual(['sendDm', 'sendInvite']);
    expect(robot.calls.find((call) => call.method === 'sendDm')?.body).toBe(AWKWARD_DM);
    expect((await actionRow('lact_auto_dm')).status).toBe('sent');
    expect((await actionRow('lact_auto_invite')).status).toBe('sent');
  });

  it('defers a claimed message whose seat switched to human-send mid-flight, then hands it over', async () => {
    await upsertSeat(db, WS, { sendMode: 'automated' }, NOW);
    await plan('lact_midflight', 'owner', 'dm', 'https://www.linkedin.com/in/midflight/', 'Hello', {
      source: 'manual'
    });
    const { driver, calls } = recordingDriver();
    const run = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'owner'), {
      driver,
      page,
      sleep: async () => {},
      log: () => {},
      now: () => NOW,
      // The founder flips the seat while the claimed row is being gated.
      evaluate: async () => {
        await upsertSeat(db, WS, { sendMode: 'human' }, NOW);
        return allowed();
      }
    });
    expect(calls).toEqual([]);
    expect(run.executed).toBe(0);
    const row = await actionRow('lact_midflight');
    expect(row.status).toBe('planned');
    expect(row.claimed_at).toBeNull();
    expect((await todayHandoffs(token, NOW)).map((item) => item.reference?.id)).toEqual([
      'lact_midflight'
    ]);
  });

  it('hands over the exact stored bytes of a campaign-planned row, the bytes the review hash covers', async () => {
    const campaignId = await campaignOn('owner', 'Exact bytes', ['exact-maya'], AWKWARD_NOTE);
    expect((await runManagedCampaigns(db, WS, NOW)).actionsPlanned).toBeGreaterThanOrEqual(1);
    const [planned] = await plannedInvites(campaignId);
    expect(planned).toBeDefined();
    // The runner rendered the merge field and kept every other byte.
    expect(planned.body).toBe(AWKWARD_NOTE.replace('{{first_name}}', 'Maya'));

    // A second human seat carries an InMail, so a subject is handed over too.
    await upsertSeat(
      db,
      WS,
      { label: 'Second', timezone: 'UTC', sendMode: 'human' },
      LONG_AGO,
      'second'
    );
    await plan(
      'lact_exact_dm',
      'second',
      'inmail',
      'https://www.linkedin.com/in/exact-dm/',
      AWKWARD_DM,
      {
        subject: 'Quick question — café ☕  ',
        source: 'manual'
      }
    );

    const handoffs = await todayHandoffs(token, dueAt(planned));
    const byId = new Map(handoffs.map((item) => [String(item.reference?.id), item]));
    expect([...byId.keys()].sort()).toEqual([planned.id, 'lact_exact_dm'].sort());

    for (const actionId of [planned.id, 'lact_exact_dm']) {
      const item = byId.get(actionId)!;
      const row = await actionRow(actionId);
      // Byte-for-byte what is stored, unicode, newlines and trailing spaces included.
      expect(item.metadata.copyText).toBe(row.body);
      expect(item.metadata.subject).toBe(row.subject);
      expect(item.metadata.targetRef).toBe(row.target_ref);
      // ... and what the exact-payload review hashes.
      const review = (await reviewLinkedInAction(db, WS, actionId))!;
      expect(review.body).toBe(item.metadata.copyText);
      expect(review.subject).toBe(row.subject);
      const asHanded = (await reviewLinkedInAction(db, WS, actionId, {
        body: String(item.metadata.copyText)
      }))!;
      expect(asHanded.contentHash).toBe(review.contentHash);
    }
  });

  it('marks a handoff sent exactly once: one outcome, one member advance, one event, even under a double click', async () => {
    // An established account: the cold-account day-over-day ramp would cap a
    // history-less seat at one invite today, and this test needs two.
    await upsertSeat(db, WS, { warmupOverride: true }, NOW);
    const campaignId = await campaignOn(
      'owner',
      'Mark sent',
      ['mark-maya', 'mark-jonas'],
      'Hi {{first_name}}'
    );
    await runManagedCampaigns(db, WS, NOW);
    const invites = await plannedInvites(campaignId);
    expect(invites).toHaveLength(2);

    // First row: shown in Today, then reported sent twice in a row.
    const shownAt = dueAt(invites[0]);
    const first = (await todayHandoffs(token, shownAt)).map((item) => String(item.reference?.id));
    expect(first).toHaveLength(1);
    const firstId = first[0];
    const clickAt = new Date(shownAt.getTime() + 2 * MINUTE);
    const once = await atTime(clickAt, () => resolveOver(token, firstId, 'sent').expect(200));
    const twice = await atTime(new Date(clickAt.getTime() + MINUTE), () =>
      resolveOver(token, firstId, 'sent').expect(200)
    );
    expect(once.body).toEqual({ handoff: { actionId: firstId, status: 'sent' } });
    expect(twice.body).toEqual(once.body);

    const firstRow = await actionRow(firstId);
    expect(firstRow.status).toBe('sent');
    expect(iso(firstRow.recorded_at)).toBe(clickAt.toISOString());
    expect(await markedSentEvents(firstId)).toHaveLength(1);
    expect(await member(firstRow.campaign_member_id!)).toMatchObject({
      step_index: 1,
      current_step_id: 'view',
      completed_step_ids: ['invite']
    });

    // Second row: Today moves on to it, and a concurrent double click records once.
    const secondRowBefore = (await plannedInvites(campaignId))[0];
    expect(secondRowBefore.id).not.toBe(firstId);
    const nextShownAt = new Date(
      Math.max(dueAt(secondRowBefore).getTime(), clickAt.getTime() + 30 * MINUTE)
    );
    const next = (await todayHandoffs(token, nextShownAt)).map((item) =>
      String(item.reference?.id)
    );
    expect(next).toEqual([secondRowBefore.id]);
    const doubleAt = new Date(nextShownAt.getTime() + MINUTE);
    const [left, right] = await atTime(doubleAt, () =>
      Promise.all([
        resolveOver(token, secondRowBefore.id, 'sent'),
        resolveOver(token, secondRowBefore.id, 'sent')
      ])
    );
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect(left.body).toEqual(right.body);
    expect(left.body).toEqual({ handoff: { actionId: secondRowBefore.id, status: 'sent' } });
    expect(await markedSentEvents(secondRowBefore.id)).toHaveLength(1);
    const secondRow = await actionRow(secondRowBefore.id);
    expect(secondRow.status).toBe('sent');
    expect(iso(secondRow.recorded_at)).toBe(doubleAt.toISOString());
    expect(await member(secondRow.campaign_member_id!)).toMatchObject({
      step_index: 1,
      current_step_id: 'view',
      completed_step_ids: ['invite']
    });
    // Nothing else is waiting on the seat.
    expect(await todayHandoffs(token, new Date(doubleAt.getTime() + MINUTE))).toEqual([]);
  });

  it('counts a hand-sent invite exactly like a worker-sent one in every analytics reader and the gate', async () => {
    // The production pre-send path runs below; let this workspace allow invites.
    await policy('allow', 'action:linkedin.invite');
    await upsertSeat(db, WS, { warmupOverride: true }, NOW);
    const campaignId = await campaignOn(
      'owner',
      'Parity',
      ['parity-maya', 'parity-jonas'],
      'Hi {{first_name}}'
    );
    await runManagedCampaigns(db, WS, NOW);
    const invites = await plannedInvites(campaignId);
    expect(invites).toHaveLength(2);

    // One invite sent by hand through Today.
    const shownAt = dueAt(invites[0]);
    const [handed] = await todayHandoffs(token, shownAt);
    const handId = String(handed.reference?.id);
    const handAt = new Date(shownAt.getTime() + MINUTE);
    await atTime(handAt, () => resolveOver(token, handId, 'sent').expect(200));
    const rolling = async (when: Date) =>
      (
        await evaluateLinkedInSafety(
          db,
          {
            workspaceId: WS,
            seatKey: 'owner',
            kind: 'invite',
            targetRef: 'https://www.linkedin.com/in/parity-next/',
            plannedFor: when.toISOString()
          },
          when
        )
      ).checks.find((entry) => entry.check === 'rolling-24h')?.detail;
    expect(await rolling(new Date(handAt.getTime() + MINUTE))).toContain('1 of');

    // The founder switches the account back to automatic (nothing presented is
    // open), and the worker sends the other invite through the real gates.
    await atTime(handAt, () =>
      as(token)
        .patch('/api/linkedin/manager/seats/owner')
        .send({ sendMode: 'automated' })
        .expect(200)
    );
    const robotId = invites.map((row) => row.id).find((actionId) => actionId !== handId)!;
    const robotAt = new Date(Math.max(dueAt(invites[1]).getTime(), handAt.getTime() + 30 * MINUTE));
    const { driver, calls } = recordingDriver();
    const run = await runLinkedInLocalBatch(
      postgresLocalWorkerStore(db, WS, 'owner'),
      productionDeps(driver, robotAt)
    );
    expect(run.executed).toBe(1);
    expect(calls.filter((call) => SEND_METHODS.has(call.method))).toHaveLength(1);

    const handRow = await actionRow(handId);
    const robotRow = await actionRow(robotId);
    for (const row of [handRow, robotRow]) {
      expect(row.status).toBe('sent');
      expect(row.recorded_at).not.toBeNull();
      expect(await member(row.campaign_member_id!)).toMatchObject({
        step_index: 1,
        completed_step_ids: ['invite']
      });
    }
    expect(iso(handRow.recorded_at)).toBe(handAt.toISOString());
    expect(iso(robotRow.recorded_at)).toBe(robotAt.toISOString());

    // Ledger funnel (the analytics screen) -- workspace and per campaign.
    const ledger = await linkedinAnalytics(db, WS, null, robotAt);
    expect(ledger.total.sent).toBe(2);
    expect(ledger.invites.invitesSent).toBe(2);
    expect(ledger.byCampaign.find((entry) => entry.campaignId === campaignId)).toMatchObject({
      sent: 2
    });
    // Managed campaign dashboard.
    expect((await managedAnalytics(db, WS, { campaignId })).invitesSent).toBe(2);
    // Rep report: totals, the day, the campaign row.
    const report = await repReport(db, WS, { from: '2026-08-04', to: '2026-08-05' }, robotAt);
    expect(report.total.invitesSent).toBe(2);
    expect(report.days.find((day) => day.date === '2026-08-04')?.invitesSent).toBe(2);
    expect(report.campaigns.find((entry) => entry.campaignId === campaignId)?.invitesSent).toBe(2);
    // The safety gate's rolling window counted the hand send as one (above)
    // and now counts both against the seat.
    expect(await rolling(new Date(robotAt.getTime() + 30 * MINUTE))).toContain('2 of');
  });

  it('refuses to edit a message once Today has presented it, and hands over an edit made before', async () => {
    await plan(
      'lact_edit_dm',
      'owner',
      'dm',
      'https://www.linkedin.com/in/edit-dm/',
      'First draft',
      {
        source: 'manual'
      }
    );

    // Before presentation the founder may still correct it ...
    const edited = await atTime(NOW, () =>
      as(token)
        .post('/api/linkedin/actions/lact_edit_dm/body')
        .send({ body: AWKWARD_DM })
        .expect(200)
    );
    expect(edited.body.action.body).toBe(AWKWARD_DM);
    // ... and Today hands over the corrected bytes.
    const [handed] = await todayHandoffs(token, NOW);
    expect(handed.reference?.id).toBe('lact_edit_dm');
    expect(handed.metadata.copyText).toBe(AWKWARD_DM);
    expect((await actionRow('lact_edit_dm')).handoff_presented_at).not.toBeNull();

    // After presentation the founder may already have pasted it: frozen.
    const refused = await atTime(NOW, () =>
      as(token)
        .post('/api/linkedin/actions/lact_edit_dm/body')
        .send({ body: 'Something else entirely' })
        .expect(409)
    );
    expect(refused.body.error).toMatch(/shown to you in Today to send by hand/);
    expect((await actionRow('lact_edit_dm')).body).toBe(AWKWARD_DM);

    // What the ledger records as sent is exactly what was handed over.
    await atTime(NOW, () => resolveOver(token, 'lact_edit_dm', 'sent').expect(200));
    const sent = await actionRow('lact_edit_dm');
    expect(sent.status).toBe('sent');
    expect(sent.body).toBe(AWKWARD_DM);
  });

  it('shows the words as stamped when an edit lands between the Today read and the stamp', async () => {
    await plan(
      'lact_race_dm',
      'owner',
      'dm',
      'https://www.linkedin.com/in/race-dm/',
      'Listed words',
      {
        source: 'manual'
      }
    );
    const listed = await listLinkedInHandoffs(db, WS, NOW);
    expect(listed.map((handoff) => handoff.copyText)).toEqual(['Listed words']);
    // The edit lands after the list, before the stamp: still allowed.
    await editQueuedMessage(db, { workspaceId: WS, actionId: 'lact_race_dm', body: AWKWARD_DM });
    const shown = await presentLinkedInHandoffs(db, WS, listed, NOW);
    expect(shown.map((handoff) => handoff.copyText)).toEqual([AWKWARD_DM]);
    // From the stamp on, the shown words are the row's words for good.
    await expect(
      editQueuedMessage(db, { workspaceId: WS, actionId: 'lact_race_dm', body: 'Too late' })
    ).rejects.toMatchObject({ status: 409 });
    expect((await actionRow('lact_race_dm')).body).toBe(AWKWARD_DM);
  });

  it('never hands over a row workspace policy denies; require_approval and allow are handed over', async () => {
    await policy('deny', 'action:linkedin.dm');
    await plan(
      'lact_policy_dm',
      'owner',
      'dm',
      'https://www.linkedin.com/in/policy-dm/',
      'Denied words',
      {
        source: 'manual',
        plannedFor: new Date(NOW.getTime() - 10 * MINUTE)
      }
    );
    // Ranks behind the denied DM, and falls to the built-in require_approval.
    await plan(
      'lact_policy_invite',
      'owner',
      'invite',
      'https://www.linkedin.com/in/policy-invite/',
      null,
      {
        plannedFor: new Date(NOW.getTime() - 5 * MINUTE)
      }
    );
    expect((await reviewLinkedInAction(db, WS, 'lact_policy_dm'))?.policy.effect).toBe('deny');
    expect((await reviewLinkedInAction(db, WS, 'lact_policy_invite'))?.policy.effect).toBe(
      'require_approval'
    );

    expect((await todayHandoffs(token, NOW)).map((item) => item.reference?.id)).toEqual([
      'lact_policy_invite'
    ]);
    expect((await actionRow('lact_policy_dm')).handoff_presented_at).toBeNull();
    // A Today read records no policy decision.
    const events = await db
      .prepare('SELECT COUNT(*)::int AS n FROM linkedin_action_policy_events WHERE workspace_id=?')
      .get<{ n: number }>(WS);
    expect(events?.n).toBe(0);

    // An explicit allow is handed over too (a second human seat, one handoff each).
    await policy('allow', 'action:linkedin.invite');
    await upsertSeat(
      db,
      WS,
      { label: 'Second', timezone: 'UTC', sendMode: 'human' },
      LONG_AGO,
      'second'
    );
    await plan(
      'lact_policy_allowed',
      'second',
      'invite',
      'https://www.linkedin.com/in/policy-allowed/',
      null
    );
    expect((await reviewLinkedInAction(db, WS, 'lact_policy_allowed'))?.policy.effect).toBe(
      'allow'
    );
    expect(
      (await todayHandoffs(token, NOW)).map((item) => String(item.reference?.id)).sort()
    ).toEqual(['lact_policy_allowed', 'lact_policy_invite']);

    // A deny that lands AFTER presentation does not hide the row: the founder
    // may already have sent it, and can still report that.
    await policy('deny', 'action:linkedin.invite', 200);
    expect(
      (await todayHandoffs(token, NOW)).map((item) => String(item.reference?.id)).sort()
    ).toEqual(['lact_policy_allowed', 'lact_policy_invite']);
    await atTime(NOW, () => resolveOver(token, 'lact_policy_invite', 'sent').expect(200));
    expect((await actionRow('lact_policy_invite')).status).toBe('sent');

    // The denied DM is still never handed over, even with the seat now free.
    expect((await todayHandoffs(token, NOW)).map((item) => item.reference?.id)).toEqual([
      'lact_policy_allowed'
    ]);
    expect((await actionRow('lact_policy_dm')).status).toBe('planned');
  });

  it("never resolves or shows another workspace's handoff", async () => {
    await plan('lact_isolated', 'owner', 'dm', 'https://www.linkedin.com/in/isolated/', 'Hello', {
      source: 'manual'
    });
    expect((await todayHandoffs(token, NOW)).map((item) => item.reference?.id)).toEqual([
      'lact_isolated'
    ]);
    expect(await todayHandoffs(otherToken, NOW)).toEqual([]);

    for (const resolution of ['sent', 'skip'] as const)
      await atTime(NOW, () => resolveOver(otherToken, 'lact_isolated', resolution).expect(404));
    const row = await actionRow('lact_isolated');
    expect(row.status).toBe('planned');
    expect(row.recorded_at).toBeNull();
    expect(await markedSentEvents('lact_isolated')).toEqual([]);
    expect(await markedSentEvents('lact_isolated', OTHER)).toEqual([]);
    // Editing it from the other workspace is refused the same way.
    await atTime(NOW, () =>
      as(otherToken)
        .post('/api/linkedin/actions/lact_isolated/body')
        .send({ body: 'Hijack' })
        .expect(404)
    );
    expect((await actionRow('lact_isolated')).body).toBe('Hello');
  });
});
