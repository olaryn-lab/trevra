/**
 * TRV-012 LinkedIn actions, end to end on real PostgreSQL with a fake driver.
 *
 * Drives the real HTTP writer (lead list, CSV import, workflow, campaign,
 * start, exact-hash approvals), the managed runner, the local-worker claim /
 * settle path, the production pre-send safety gate (`evaluateLinkedInSafety`
 * with the row's own facts) and the readers. Does NOT prove live LinkedIn DOM
 * behaviour, a real browser session, or companion pairing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { runManagedCampaigns } from './runner.js';
import { postgresLocalWorkerStore, runLinkedInLocalBatch } from './local-worker.js';
import { linkedinActionPolicyGate } from './action-policy.js';
import { evaluateLinkedInSafety, linkedInDailyAllowance } from './guard.js';
import { FLAT_DAY_SHAPE } from './pacing.js';
import { recordAction } from './actions.js';
import { getSeat, setSeatCapabilities, upsertSeat } from './seats.js';
import { runWithdrawalBatch } from './withdraw.js';
import type { LinkedInDriver, LinkedInDriverResult, LinkedInPage } from './driver.js';
import type { LinkedInWithdrawDriver, LinkedInListPage } from './driver-withdraw.js';
import type { PacedKind } from './limits.js';

let db: Db;
let app: Express;
let workspace: string;
let token: string;
let iteration = 0;

const HOUR = 3_600_000;
/** Next UTC day at 09:00 -- clear of the gate's edge-of-day handling. */
const T0 = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 9 * HOUR);
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function client() {
  const cookie = 'trevra_session=' + token;
  return {
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string) => request(app).post(url).set('Cookie', cookie)
  };
}

async function session(ws: string) {
  const user = 'usr_' + ws;
  await db.prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,now())').run(ws, ws);
  await db
    .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,now())')
    .run(user, ws, user + '@trevra.test', user);
  const value = randomBytes(32).toString('hex');
  await db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,now()+interval '1 day',now())"
    )
    .run(createHash('sha256').update(value).digest('hex'), user);
  return value;
}

async function startCampaign(name: string, leads: string[][], steps: unknown[]) {
  const http = client();
  const csv = [
    'First Name,Last Name,Company,LinkedIn URL',
    ...leads.map((row) => row.join(','))
  ].join('\n');
  const list = (
    await http
      .post('/api/linkedin/manager/lead-lists')
      .send({ name: name + ' list', sourceKind: 'csv' })
      .expect(201)
  ).body.list;
  await http
    .post('/api/linkedin/manager/lead-lists/' + list.id + '/import')
    .attach('file', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' })
    .expect(201);
  const workflow = (
    await http
      .post('/api/linkedin/manager/workflows')
      .send({ name: name + ' workflow', steps })
      .expect(201)
  ).body.workflow;
  const campaign = (
    await http
      .post('/api/linkedin/manager/campaigns')
      .send({ name, leadListId: list.id, workflowId: workflow.id, senderKeys: ['owner'] })
      .expect(201)
  ).body.campaign;
  await http
    .post('/api/linkedin/manager/campaigns/' + campaign.id + '/start')
    .send({})
    .expect(200);
  return campaign.id as string;
}

/** Approve every pending exact-hash review through the operator route. */
async function approveAll(): Promise<number> {
  const reviews = (await client().get('/api/linkedin/manager/action-approvals').expect(200)).body
    .reviews as Array<{ actionId: string; contentHash: string }>;
  for (const review of reviews)
    await client()
      .post('/api/linkedin/manager/action-approvals/' + review.actionId)
      .send({ contentHash: review.contentHash })
      .expect(200);
  return reviews.length;
}

type Call = { method: string; args: unknown[] };
const sent =
  (method: string) =>
  (target: string): LinkedInDriverResult => ({
    ok: true,
    externalRef: `ref:${method}:${target}`,
    failureKind: null
  });

function fakeDriver(
  calls: Call[],
  outcome: (method: string, target: string) => LinkedInDriverResult = (method, target) =>
    sent(method)(target)
): LinkedInDriver {
  const routine =
    (method: string) =>
    async (_page: LinkedInPage, ...args: unknown[]): Promise<LinkedInDriverResult> => {
      calls.push({ method, args });
      return outcome(method, String(args[0]));
    };
  return {
    sendInvite: routine('sendInvite'),
    sendDm: routine('sendDm'),
    sendInMail: routine('sendInMail'),
    viewProfile: routine('viewProfile'),
    followProfile: routine('followProfile'),
    likeRecentPost: routine('likeRecentPost'),
    endorseSkills: routine('endorseSkills')
  } as unknown as LinkedInDriver;
}

const logs: string[] = [];
/**
 * One worker pass wired exactly like `runLinkedInLocalWorker`: the real gate
 * fed the claimed row's facts (FLAT_DAY_SHAPE so a ceiling is the ceiling),
 * and the exact-payload workspace policy gate.
 */
function work(driver: LinkedInDriver, when: Date, maxActions = 25) {
  return runLinkedInLocalBatch(postgresLocalWorkerStore(db, workspace, 'owner'), {
    driver,
    page: {} as LinkedInPage,
    now: () => when,
    sleep: async () => {},
    log: (line) => logs.push(line),
    maxActions,
    evaluate: (action, instant) =>
      evaluateLinkedInSafety(
        db,
        {
          workspaceId: action.workspaceId,
          seatKey: action.seatKey,
          kind: action.kind as PacedKind,
          targetRef: action.targetRef,
          plannedFor: instant.toISOString(),
          ...(action.campaignId ? { campaignId: action.campaignId } : {}),
          ...(action.replayScope ? { replayScope: action.replayScope } : {}),
          ...(action.manual ? { manual: true } : {})
        },
        instant,
        { excludeActionId: action.id, dayShape: FLAT_DAY_SHAPE }
      ),
    authorizeAction: (action) =>
      linkedinActionPolicyGate(db, workspace, action.id, {
        kind: action.kind,
        seatKey: action.seatKey,
        targetRef: action.targetRef,
        body: action.body,
        subject: action.subject,
        threadUrn: action.threadUrn,
        attachment: action.attachment,
        channelMetadata: action.channelMetadata
      })
  });
}

/** Latest due slot among unclaimed planned rows, so a worker pass can reach all of them. */
async function dueBy(floor: Date): Promise<Date> {
  const row = await db
    .prepare(
      `SELECT MAX(planned_for) AS latest FROM linkedin_actions
       WHERE workspace_id=? AND status='planned' AND claimed_at IS NULL`
    )
    .get<{ latest: string | Date | null }>(workspace);
  const latest = row?.latest ? new Date(row.latest) : floor;
  return new Date(Math.max(latest.getTime(), floor.getTime()) + 60_000);
}

interface ActionRow {
  id: string;
  kind: string;
  status: string;
  target_ref: string;
  body: string | null;
  subject: string | null;
  claimed: boolean;
  held: boolean;
  recorded_at: string | Date | null;
  external_ref: string | null;
  failure_kind: string | null;
  channel_metadata_json: Record<string, unknown> | string | null;
  workflow_step_id: string | null;
}

async function rows(campaignId?: string): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,kind,status,target_ref,body,subject,claimed_at IS NOT NULL AS claimed,
              settlement_hold_at IS NOT NULL AS held,recorded_at,external_ref,failure_kind,
              channel_metadata_json,workflow_step_id
       FROM linkedin_actions WHERE workspace_id=? AND (?::text IS NULL OR campaign_id=?)
       ORDER BY created_at,id`
    )
    .all<ActionRow>(workspace, campaignId ?? null, campaignId ?? null);
}

const metadataOf = (row: ActionRow) =>
  (typeof row.channel_metadata_json === 'string'
    ? JSON.parse(row.channel_metadata_json)
    : row.channel_metadata_json) as Record<string, unknown>;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  iteration++;
  workspace = 'ws_trv012_' + iteration;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  token = await session(workspace);
  logs.length = 0;
  // An established account (warmup skipped, steady bands), open all week so
  // the only thing that can refuse an action is the ceiling under test.
  await upsertSeat(
    db,
    workspace,
    {
      label: 'TRV-012 owner',
      timezone: 'UTC',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workStartMinute: 0,
      workEndMinute: 1440,
      warmupOverride: true
    },
    new Date()
  );
  await setSeatCapabilities(db, workspace, 'owner', { inmail: 'available' });
});
afterEach(async () => {
  await db?.close();
});

describe('TRV-012 LinkedIn actions: planned -> claimed -> recorded outcome', () => {
  it('walks every supported kind through the real planner, approvals, claim and settlement', async () => {
    const walk = await startCampaign(
      'Every kind',
      [['Ana', 'Walk', 'Acme', 'https://www.linkedin.com/in/trv012-ana/']],
      [
        { id: 'view', action: 'profile_view', config: {} },
        { id: 'follow', action: 'follow', config: {} },
        { id: 'like', action: 'like_post', config: {} },
        { id: 'endorse', action: 'endorse_skills', config: { maxSkills: 4 } },
        {
          id: 'inmail',
          action: 'inmail',
          config: {
            subject: 'Quick question, {{first_name}}',
            variants: [{ id: 'a', body: 'InMail for {{first_name}} at {{company}}', weight: 100 }],
            allowPaid: false
          }
        },
        {
          id: 'invite',
          action: 'connection_request',
          config: { message: 'Hello {{first_name}} at {{company}}' }
        },
        { id: 'withdraw', action: 'withdraw_pending', config: { afterDays: 1 } }
      ]
    );
    const dm = await startCampaign(
      'Direct message',
      [['Ben', 'Message', 'Beta', 'https://www.linkedin.com/in/trv012-ben/']],
      [
        {
          id: 'dm',
          action: 'message',
          config: { variants: [{ id: 'a', body: 'Thanks {{first_name}}', weight: 100 }] }
        }
      ]
    );
    const bare = await startCampaign(
      'Invite without note',
      [['Cy', 'Bare', 'Gamma', 'https://www.linkedin.com/in/trv012-cy/']],
      [{ id: 'invite', action: 'connection_request', config: {} }]
    );

    const calls: Call[] = [];
    const driver = fakeDriver(calls);
    const plannedSnapshot = new Map<string, ActionRow>();
    let clock = at(0);
    for (let cycle = 0; cycle < 12; cycle++) {
      await runManagedCampaigns(db, workspace, clock);
      for (const row of await rows())
        if (row.status === 'planned' && !plannedSnapshot.has(row.id))
          plannedSnapshot.set(row.id, row);
      await approveAll();
      clock = await dueBy(clock);
      await work(driver, clock);
      clock = new Date(clock.getTime() + 10 * 60_000);
      const walkRows = await rows(walk);
      if (walkRows.some((row) => row.kind === 'invite' && row.status === 'sent')) break;
    }

    // Every row was written 'planned' and unclaimed by the planner, before any browser work.
    const planned = [...plannedSnapshot.values()];
    expect(planned.map((row) => row.kind).sort()).toEqual(
      ['dm', 'endorse', 'follow', 'inmail', 'invite', 'invite', 'like', 'profile_view'].sort()
    );
    for (const row of planned) expect(row).toMatchObject({ claimed: false, recorded_at: null });

    const all = await rows();
    const one = (campaign: string, kind: string) =>
      all.find((row) => row.kind === kind && rowsCampaign.get(row.id) === campaign)!;
    const rowsCampaign = new Map(
      (
        await db
          .prepare('SELECT id,campaign_id FROM linkedin_actions WHERE workspace_id=?')
          .all<{ id: string; campaign_id: string }>(workspace)
      ).map((row) => [row.id, row.campaign_id])
    );

    const expectations: Array<[string, string, string, unknown[]]> = [
      [walk, 'profile_view', 'viewProfile', ['https://www.linkedin.com/in/trv012-ana/']],
      [walk, 'follow', 'followProfile', ['https://www.linkedin.com/in/trv012-ana/']],
      [
        walk,
        'like',
        'likeRecentPost',
        ['https://www.linkedin.com/in/trv012-ana/', { seed: expect.any(String) }]
      ],
      [
        walk,
        'endorse',
        'endorseSkills',
        ['https://www.linkedin.com/in/trv012-ana/', { seed: expect.any(String), maxSkills: 4 }]
      ],
      [
        walk,
        'inmail',
        'sendInMail',
        [
          'https://www.linkedin.com/in/trv012-ana/',
          'Quick question, Ana',
          'InMail for Ana at Acme',
          expect.objectContaining({ allowPaid: false })
        ]
      ],
      [
        walk,
        'invite',
        'sendInvite',
        ['https://www.linkedin.com/in/trv012-ana/', 'Hello Ana at Acme']
      ],
      [
        dm,
        'dm',
        'sendDm',
        ['https://www.linkedin.com/in/trv012-ben/', 'Thanks Ben', expect.any(Object)]
      ],
      [bare, 'invite', 'sendInvite', ['https://www.linkedin.com/in/trv012-cy/', undefined]]
    ];
    for (const [campaign, kind, method, args] of expectations) {
      const row = one(campaign, kind);
      expect(row, `${kind} row`).toBeDefined();
      // Claimed, then settled as a recorded success carrying the driver's reference.
      expect(row).toMatchObject({
        status: 'sent',
        claimed: true,
        held: false,
        failure_kind: null,
        external_ref: `ref:${method}:${String(args[0])}`
      });
      expect(row.recorded_at).not.toBeNull();
      // The driver was called exactly once for this action, with the approved bytes.
      const matching = calls.filter((call) => call.method === method && call.args[0] === args[0]);
      expect(matching, `${method} calls`).toHaveLength(1);
      expect(matching[0].args).toEqual(args);
    }
    expect(one(walk, 'invite').body).toBe('Hello Ana at Acme');
    expect(one(bare, 'invite').body).toBeNull();
    expect(one(walk, 'inmail').subject).toBe('Quick question, Ana');
    expect(metadataOf(one(walk, 'endorse'))).toMatchObject({ maxSkills: 4 });
    expect(calls).toHaveLength(8);

    // Withdraw: the workflow's withdraw_pending step queues the stale invite a
    // day later; the exact withdrawal is approved and executed by the paced pass.
    const inviteSentAt = new Date(one(walk, 'invite').recorded_at!);
    const later = new Date(inviteSentAt.getTime() + 25 * HOUR);
    await runManagedCampaigns(db, workspace, later);
    const withdrawals = (await client().get('/api/linkedin/withdrawals/approvals').expect(200)).body
      .reviews as Array<{ withdrawalId: string; contentHash: string; targetRef: string }>;
    expect(withdrawals.map((review) => review.targetRef)).toEqual([
      'https://www.linkedin.com/in/trv012-ana/'
    ]);
    const withdrawn: string[] = [];
    const withdrawDriver: LinkedInWithdrawDriver = {
      listPendingInvites: async () => ({ ok: false, failureKind: 'unknown' }),
      withdrawInvite: async (_page, profileUrl) => {
        withdrawn.push(profileUrl);
        return { ok: true, externalRef: profileUrl, failureKind: null };
      }
    };
    // Unapproved: refused before the browser is touched.
    const refused = await runWithdrawalBatch(
      db,
      { workspaceId: workspace, seatKey: 'owner' },
      {
        driver: withdrawDriver,
        page: {} as LinkedInListPage,
        batchId: 'lbatch_trv012_refused',
        now: () => later,
        sleep: async () => {}
      }
    );
    expect(refused).toMatchObject({ withdrawn: 0, blocked: 1 });
    expect(withdrawn).toHaveLength(0);
    await client()
      .post('/api/linkedin/withdrawals/approvals/' + withdrawals[0].withdrawalId)
      .send({ contentHash: withdrawals[0].contentHash })
      .expect(200);
    const done = await runWithdrawalBatch(
      db,
      { workspaceId: workspace, seatKey: 'owner' },
      {
        driver: withdrawDriver,
        page: {} as LinkedInListPage,
        batchId: 'lbatch_trv012',
        now: () => later,
        sleep: async () => {}
      }
    );
    expect(done).toMatchObject({ withdrawn: 1, halted: false });
    expect(withdrawn).toEqual(['https://www.linkedin.com/in/trv012-ana/']);
    const after = await rows(walk);
    expect(after.find((row) => row.kind === 'invite')?.status).toBe('withdrawn');
    expect(after.find((row) => row.kind === 'withdraw')).toMatchObject({
      status: 'sent',
      external_ref: one(walk, 'invite').id
    });

    // The readers count exactly what was recorded.
    const analytics = (await client().get('/api/linkedin/manager/analytics').expect(200)).body;
    expect(analytics).toMatchObject({
      invitesSent: 1,
      invitesWithdrawn: 1,
      withdrawalsPerformed: 1,
      messagesSent: 2,
      profileViews: 1,
      followsSent: 1
    });

    // A repeated pass finds nothing: no action is ever sent twice.
    expect((await work(driver, new Date(later.getTime() + HOUR))).executed).toBe(0);
    expect(calls).toHaveLength(8);
  });

  it('records unknown and lost-session outcomes as unknown, never as sent, and never re-sends them', async () => {
    const followCampaign = await startCampaign(
      'Unknown follow',
      [['Dee', 'Unknown', 'Acme', 'https://www.linkedin.com/in/trv012-dee/']],
      [{ id: 'follow', action: 'follow', config: {} }]
    );
    const inviteCampaign = await startCampaign(
      'Lost session invite',
      [['Eve', 'Lost', 'Beta', 'https://www.linkedin.com/in/trv012-eve/']],
      [{ id: 'invite', action: 'connection_request', config: { message: 'Hi {{first_name}}' } }]
    );
    await runManagedCampaigns(db, workspace, at(0));
    await approveAll();
    const calls: Call[] = [];
    const driver = fakeDriver(calls, (method) =>
      method === 'followProfile'
        ? { ok: false, failureKind: 'unknown', detail: 'clicked, page never confirmed' }
        : { ok: false, failureKind: 'session_lost', detail: 'browser disconnected mid-send' }
    );
    const when = await dueBy(at(0));
    const first = await work(driver, when);
    const second = await work(driver, when);
    // Each uncertain outcome halts its pass; neither is counted as executed.
    expect([first.halted, second.halted]).toEqual([true, true]);
    expect(first.executed + second.executed).toBe(0);
    expect(calls.map((call) => call.method).sort()).toEqual(['followProfile', 'sendInvite']);

    for (const campaign of [followCampaign, inviteCampaign]) {
      const [row] = await rows(campaign);
      expect(row).toMatchObject({
        status: 'planned',
        claimed: true,
        held: true,
        failure_kind: 'unknown',
        recorded_at: null,
        external_ref: null
      });
      const detail = (
        await client()
          .get('/api/linkedin/manager/campaigns/' + campaign)
          .expect(200)
      ).body;
      expect(detail.members[0].status).not.toBe('completed');
    }
    const analytics = (await client().get('/api/linkedin/manager/analytics').expect(200)).body;
    expect(analytics).toMatchObject({ invitesSent: 0, followsSent: 0 });

    // The held rows are never claimed again by a later pass or a later tick.
    await runManagedCampaigns(db, workspace, at(30));
    expect((await work(driver, at(30))).executed).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('respects a daily ceiling at the boundary and refuses one past it at send time', async () => {
    // Operator ceiling of 4 invites/day (stricter than the 18/day steady band).
    await upsertSeat(db, workspace, { dailyInviteLimit: 4 }, new Date());
    const campaign = await startCampaign(
      'Daily ceiling',
      ['a', 'b', 'c', 'd', 'e'].map((handle) => [
        'Lead',
        handle.toUpperCase(),
        'Acme',
        `https://www.linkedin.com/in/trv012-daily-${handle}/`
      ]),
      [{ id: 'invite', action: 'connection_request', config: { message: 'Hi {{first_name}}' } }]
    );
    // What the send gate admits today: today's draw of the 4/day ceiling.
    const today = await linkedInDailyAllowance(
      db,
      { workspaceId: workspace, seatKey: 'owner' },
      await getSeat(db, workspace, 'owner'),
      'invite',
      at(0)
    );
    expect(today.remaining).toBeGreaterThan(1);
    expect(today.remaining).toBeLessThanOrEqual(4);
    await runManagedCampaigns(db, workspace, at(0));
    // Planner boundary: exactly the allowance is planned, the other leads wait.
    expect((await rows(campaign)).filter((row) => row.status === 'planned')).toHaveLength(
      today.remaining
    );
    await approveAll();

    // The operator tightens the ceiling by one after the queue was planned.
    // (This worker's gate judges the undrawn ceiling, FLAT_DAY_SHAPE.)
    const tightened = today.remaining - 1;
    await upsertSeat(db, workspace, { dailyInviteLimit: tightened }, new Date());
    const calls: Call[] = [];
    const when = await dueBy(at(0));
    const pass = await work(fakeDriver(calls), when);
    expect(pass).toMatchObject({ executed: tightened, blocked: 1 });
    expect(calls).toHaveLength(tightened);
    const settled = await rows(campaign);
    expect(settled.filter((row) => row.status === 'sent')).toHaveLength(tightened);
    const refused = settled.filter((row) => row.status === 'planned');
    expect(refused).toHaveLength(1);
    // Released, not consumed: unclaimed, unrecorded, ready for tomorrow.
    expect(refused[0]).toMatchObject({ claimed: false, held: false, recorded_at: null });
    // The refusal names the number that bound, not just the check.
    expect(
      logs.some(
        (line) =>
          line.includes(refused[0].id) && line.includes(`${tightened} of ${tightened} invites used`)
      )
    ).toBe(true);

    // A day later the same row goes through; nothing was double-sent.
    const tomorrow = new Date(when.getTime() + 24 * HOUR + 60_000);
    expect((await work(fakeDriver(calls), tomorrow)).executed).toBe(1);
    expect(new Set(calls.map((call) => call.args[0])).size).toBe(today.remaining);
  });

  it('respects the weekly invite band at the boundary and refuses one past it', async () => {
    // A non-established account past its warm-up (activated 60 days ago), so
    // the researched steady band applies: 18/day, 90/week. 89 invites were
    // already decided in the last 7 days, all outside the 24h window.
    await db
      .prepare(
        `UPDATE linkedin_seats SET warmup_override=false, activated_at=?::timestamptz
         WHERE workspace_id=? AND seat_key='owner'`
      )
      .run(new Date(at(0).getTime() - 60 * 24 * HOUR).toISOString(), workspace);
    for (let index = 0; index < 89; index++) {
      await recordAction(
        db,
        {
          workspaceId: workspace,
          kind: 'invite',
          targetRef: `https://www.linkedin.com/in/trv012-history-${index}/`,
          status: 'accepted',
          source: 'campaign',
          recordedAt: new Date(at(0).getTime() - (2 + (index % 4)) * 24 * HOUR).toISOString()
        },
        at(0)
      );
    }
    const campaign = await startCampaign(
      'Weekly ceiling',
      ['f', 'g'].map((handle) => [
        'Lead',
        handle.toUpperCase(),
        'Acme',
        `https://www.linkedin.com/in/trv012-weekly-${handle}/`
      ]),
      [{ id: 'invite', action: 'connection_request', config: { message: 'Hi {{first_name}}' } }]
    );
    await runManagedCampaigns(db, workspace, at(0));
    // Planner boundary: the week's last invite is planned, the second lead waits.
    expect((await rows(campaign)).filter((row) => row.status === 'planned')).toHaveLength(1);
    await approveAll();
    const calls: Call[] = [];
    const when = await dueBy(at(0));
    const pass = await work(fakeDriver(calls), when);
    expect(pass).toMatchObject({ executed: 1, blocked: 0 });
    expect(calls).toHaveLength(1);
    // One past: the gate refuses the next invite on the rolling week.
    const past = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: workspace,
        seatKey: 'owner',
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/trv012-weekly-g/',
        plannedFor: when.toISOString()
      },
      when,
      { dayShape: FLAT_DAY_SHAPE }
    );
    const week = past.checks.find((check) => check.check === 'rolling-7d');
    expect(week).toMatchObject({ passed: false });
    expect(week?.detail).toContain('90 of 90');
    // The planner does not plan it either.
    await runManagedCampaigns(db, workspace, new Date(when.getTime() + 60_000));
    expect((await rows(campaign)).filter((row) => row.status === 'planned')).toHaveLength(0);
  });
});
