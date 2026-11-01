/**
 * TRV-014 company, group and event actions, end to end on real PostgreSQL with
 * a fake driver.
 *
 * Drives the real HTTP writer (lead list, CSV import, workflow validation,
 * campaign, start, exact-hash approvals), the managed runner, the local-worker
 * claim / settle path with the production pre-send gate and the exact-payload
 * policy gate. Does NOT prove live LinkedIn DOM behaviour, seat eligibility
 * (company-admin invite rights, group/event membership), or a real browser.
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
import { evaluateLinkedInSafety } from './guard.js';
import { FLAT_DAY_SHAPE } from './pacing.js';
import { upsertSeat } from './seats.js';
import type { LinkedInDriver, LinkedInDriverResult, LinkedInPage } from './driver.js';
import type { PacedKind } from './limits.js';

let db: Db;
let app: Express;
let workspace: string;
let token: string;
let iteration = 0;

const HOUR = 3_600_000;
/** Next UTC day at 09:00 -- clear of the gate's edge-of-day handling. */
const T0 = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 9 * HOUR);

const COMPANY = 'https://www.linkedin.com/company/trevra-acme/';
const EVENT = 'https://www.linkedin.com/events/7300000000000000001/';
const GROUP = 'https://www.linkedin.com/groups/9100001/';

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
const COMMUNITY_METHODS = [
  'followCompany',
  'likeCompanyRecentPost',
  'inviteConnectionToFollowCompany',
  'inviteConnectionToEvent',
  'inviteConnectionToGroup',
  'messageGroupMember',
  'messageEventAttendee'
] as const;
const BASE_METHODS = [
  'sendInvite',
  'sendDm',
  'sendInMail',
  'viewProfile',
  'followProfile',
  'likeRecentPost',
  'endorseSkills'
] as const;

/**
 * `withCommunity: false` is a worker whose driver predates the community
 * routines (the optional methods on `LinkedInDriver` are simply absent).
 */
function fakeDriver(
  calls: Call[],
  withCommunity: boolean,
  outcome: (method: string, args: unknown[]) => LinkedInDriverResult = (method, args) => ({
    ok: true,
    externalRef: `ref:${method}:${String(args[0])}`,
    failureKind: null
  })
): LinkedInDriver {
  const routine =
    (method: string) =>
    async (_page: LinkedInPage, ...args: unknown[]): Promise<LinkedInDriverResult> => {
      calls.push({ method, args });
      return outcome(method, args);
    };
  const methods: readonly string[] = withCommunity
    ? [...BASE_METHODS, ...COMMUNITY_METHODS]
    : BASE_METHODS;
  return Object.fromEntries(methods.map((m) => [m, routine(m)])) as unknown as LinkedInDriver;
}

const logs: string[] = [];
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
  claimed: boolean;
  recorded_at: string | Date | null;
  external_ref: string | null;
  failure_kind: string | null;
  channel_metadata_json: Record<string, unknown> | string | null;
  campaign_id: string;
}

async function rows(campaignId?: string): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,kind,status,target_ref,body,claimed_at IS NOT NULL AS claimed,recorded_at,
              external_ref,failure_kind,channel_metadata_json,campaign_id
       FROM linkedin_actions WHERE workspace_id=? AND (?::text IS NULL OR campaign_id=?)
       ORDER BY created_at,id`
    )
    .all<ActionRow>(workspace, campaignId ?? null, campaignId ?? null);
}

async function members(campaignId: string) {
  return db
    .prepare(
      `SELECT c.profile_url, m.status, m.current_step_id, m.last_failure_reason
       FROM linkedin_campaign_members m JOIN linkedin_lead_contacts c ON c.id=m.contact_id
       WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY c.profile_url`
    )
    .all<{
      profile_url: string;
      status: string;
      current_step_id: string | null;
      last_failure_reason: string | null;
    }>(workspace, campaignId);
}

const metadataOf = (row: ActionRow) =>
  (typeof row.channel_metadata_json === 'string'
    ? JSON.parse(row.channel_metadata_json)
    : row.channel_metadata_json) as Record<string, unknown>;

/** Plan, approve and work until `done` holds or the cycle budget is spent. */
async function drive(driver: LinkedInDriver, done: () => Promise<boolean>, cycles = 20) {
  let clock = T0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    await runManagedCampaigns(db, workspace, clock);
    await approveAll();
    clock = await dueBy(clock);
    await work(driver, clock);
    clock = new Date(clock.getTime() + 10 * 60_000);
    if (await done()) break;
  }
  await runManagedCampaigns(db, workspace, clock);
  return clock;
}

const ALL_COMMUNITY_STEPS = [
  { id: 'follow-co', action: 'follow_company', config: { companyUrl: COMPANY } },
  { id: 'like-co', action: 'like_company_post', config: { companyUrl: COMPANY } },
  { id: 'invite-co', action: 'invite_to_follow_company', config: { companyUrl: COMPANY } },
  { id: 'invite-ev', action: 'invite_to_event', config: { eventUrl: EVENT } },
  { id: 'invite-gr', action: 'invite_to_group', config: { groupUrl: GROUP } },
  {
    id: 'msg-gr',
    action: 'group_message',
    config: {
      groupUrl: GROUP,
      variants: [{ id: 'a', body: 'Hi {{first_name}}, saw you in the group', weight: 100 }]
    }
  },
  {
    id: 'msg-ev',
    action: 'event_message',
    config: {
      eventUrl: EVENT,
      variants: [
        { id: 'a', body: 'See you at the event, {{first_name}} from {{company}}', weight: 100 }
      ]
    }
  }
];

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  iteration++;
  workspace = 'ws_trv014_' + iteration;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  token = await session(workspace);
  logs.length = 0;
  await upsertSeat(
    db,
    workspace,
    {
      label: 'TRV-014 owner',
      timezone: 'UTC',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workStartMinute: 0,
      workEndMinute: 1440,
      warmupOverride: true
    },
    new Date()
  );
});
afterEach(async () => {
  await db?.close();
});

describe('TRV-014 company, group and event actions', () => {
  it('refuses a community step whose destination is not that kind of LinkedIn page', async () => {
    const http = client();
    const bad: Array<[string, Record<string, unknown>]> = [
      ['follow_company', { companyUrl: 'http://www.linkedin.com/company/acme/' }],
      ['follow_company', { companyUrl: 'https://linkedin.com.evil.test/company/acme/' }],
      ['like_company_post', { companyUrl: 'https://www.linkedin.com/groups/9100001/' }],
      ['invite_to_follow_company', { companyUrl: 'https://www.linkedin.com/in/someone/' }],
      ['invite_to_event', { eventUrl: COMPANY }],
      ['invite_to_group', { groupUrl: EVENT }],
      ['group_message', { groupUrl: COMPANY, variants: [{ id: 'a', body: 'Hi', weight: 100 }] }],
      ['event_message', { eventUrl: GROUP, variants: [{ id: 'a', body: 'Hi', weight: 100 }] }],
      ['group_message', { groupUrl: GROUP, variants: [] }]
    ];
    for (const [action, config] of bad) {
      const response = await http
        .post('/api/linkedin/manager/workflows')
        .send({ name: 'bad ' + action, steps: [{ id: 's1', action, config }] });
      expect(response.status, `${action} ${JSON.stringify(config)}`).toBe(400);
    }
    const workflows = await db
      .prepare('SELECT COUNT(*)::int AS n FROM linkedin_workflows WHERE workspace_id=?')
      .get<{ n: number }>(workspace);
    expect(workflows?.n).toBe(0);
  });

  it('plans, approves and executes all seven community kinds with the exact destination and body', async () => {
    const profile = 'https://www.linkedin.com/in/trv014-dana/';
    const campaign = await startCampaign(
      'Community walk',
      [['Dana', 'Walk', 'Acme', profile]],
      ALL_COMMUNITY_STEPS
    );
    const calls: Call[] = [];
    const driver = fakeDriver(calls, true);
    await drive(
      driver,
      async () => (await rows(campaign)).filter((r) => r.status === 'sent').length >= 7
    );

    const all = await rows(campaign);
    const kinds = [
      'company_follow',
      'company_like',
      'company_invite_follow',
      'event_invite',
      'group_invite',
      'group_message',
      'event_message'
    ];
    expect(all.map((row) => row.kind)).toEqual(kinds);
    const seed = { seed: expect.any(String) };
    const expected: Array<[string, string, unknown[], Record<string, unknown>]> = [
      ['company_follow', 'followCompany', [COMPANY, seed], { companyUrl: COMPANY }],
      ['company_like', 'likeCompanyRecentPost', [COMPANY, seed], { companyUrl: COMPANY }],
      [
        'company_invite_follow',
        'inviteConnectionToFollowCompany',
        [profile, COMPANY, seed],
        { companyUrl: COMPANY }
      ],
      ['event_invite', 'inviteConnectionToEvent', [profile, EVENT, seed], { eventUrl: EVENT }],
      ['group_invite', 'inviteConnectionToGroup', [profile, GROUP, seed], { groupUrl: GROUP }],
      [
        'group_message',
        'messageGroupMember',
        [profile, GROUP, 'Hi Dana, saw you in the group', seed],
        { groupUrl: GROUP }
      ],
      [
        'event_message',
        'messageEventAttendee',
        [profile, EVENT, 'See you at the event, Dana from Acme', seed],
        { eventUrl: EVENT }
      ]
    ];
    for (const [kind, method, args, metadata] of expected) {
      const row = all.find((candidate) => candidate.kind === kind)!;
      expect(row.target_ref).toBe(profile);
      expect(metadataOf(row)).toMatchObject(metadata);
      expect(row).toMatchObject({
        status: 'sent',
        claimed: true,
        failure_kind: null,
        external_ref: `ref:${method}:${String(args[0])}`
      });
      expect(row.recorded_at).not.toBeNull();
      const made = calls.filter((call) => call.method === method);
      expect(made, `${method} calls`).toHaveLength(1);
      expect(made[0].args).toEqual(args);
    }
    expect(all.find((row) => row.kind === 'group_message')!.body).toBe(
      'Hi Dana, saw you in the group'
    );
    // One driver call per action, in workflow order, and the lead finished the sequence.
    expect(calls.map((call) => call.method)).toEqual([...COMMUNITY_METHODS]);
    expect(await members(campaign)).toEqual([
      expect.objectContaining({ profile_url: profile, status: 'completed' })
    ]);

    // Nothing is re-sent on later passes.
    const later = new Date(T0.getTime() + 48 * HOUR);
    await runManagedCampaigns(db, workspace, later);
    await work(driver, later);
    expect(calls).toHaveLength(7);
  });

  it('a company the seat already follows or liked advances later leads instead of failing them', async () => {
    // follow_company / like_company_post act on ONE configured page for the
    // seat, but are planned once per lead. The real driver answers the second
    // lead with `already_connected` ("This seat already follows ...").
    const leads = [
      ['Eli', 'One', 'Acme', 'https://www.linkedin.com/in/trv014-eli/'],
      ['Fay', 'Two', 'Acme', 'https://www.linkedin.com/in/trv014-fay/'],
      ['Gus', 'Three', 'Acme', 'https://www.linkedin.com/in/trv014-gus/']
    ];
    const campaign = await startCampaign('Company page', leads, [
      ALL_COMMUNITY_STEPS[0],
      ALL_COMMUNITY_STEPS[1],
      { id: 'view', action: 'profile_view', config: {} }
    ]);
    const calls: Call[] = [];
    const done = new Set<string>();
    const driver = fakeDriver(calls, true, (method, args) => {
      if (method === 'followCompany' || method === 'likeCompanyRecentPost') {
        if (done.has(method))
          return {
            ok: false,
            failureKind: 'already_connected',
            detail: `This seat already follows ${String(args[0])}; there is nothing to do.`
          };
        done.add(method);
      }
      return { ok: true, externalRef: `ref:${method}:${String(args[0])}`, failureKind: null };
    });
    await drive(
      driver,
      async () =>
        (await members(campaign)).every(
          (member) => member.status !== 'active' && member.status !== 'waiting'
        ),
      30
    );

    // Every lead finished; none was parked as failed on a page that was already followed/liked.
    expect((await members(campaign)).map((member) => member.status)).toEqual([
      'completed',
      'completed',
      'completed'
    ]);
    const all = await rows(campaign);
    const follows = all.filter((row) => row.kind === 'company_follow');
    const likes = all.filter((row) => row.kind === 'company_like');
    // The page was followed and liked exactly once; the redundant rows are
    // skipped, carry no failure and consume no rolling limit.
    for (const group of [follows, likes]) {
      expect(group.map((row) => row.status).sort()).toEqual(['sent', 'skipped', 'skipped']);
      for (const row of group.filter((candidate) => candidate.status === 'skipped'))
        expect(row).toMatchObject({ failure_kind: null, recorded_at: null });
    }
    expect(all.filter((row) => row.kind === 'profile_view' && row.status === 'sent')).toHaveLength(
      3
    );
  });

  it('a worker without a community routine refuses with compose_unavailable and records no success', async () => {
    const campaigns = new Map<string, string>();
    for (const [index, step] of ALL_COMMUNITY_STEPS.entries())
      campaigns.set(
        step.action,
        await startCampaign(
          'No routine ' + step.action,
          [['Lead' + index, 'Gap', 'Acme', `https://www.linkedin.com/in/trv014-gap-${index}/`]],
          [step]
        )
      );
    const calls: Call[] = [];
    const driver = fakeDriver(calls, false);
    await drive(
      driver,
      async () => (await rows()).filter((row) => row.status === 'skipped').length >= 7
    );

    // Not one community method was called, and no row claims a send.
    expect(calls).toEqual([]);
    const all = await rows();
    expect(all).toHaveLength(7);
    for (const row of all) {
      expect(row).toMatchObject({
        status: 'skipped',
        claimed: false,
        recorded_at: null,
        external_ref: null,
        failure_kind: 'compose_unavailable'
      });
    }
    for (const campaign of campaigns.values())
      expect(await members(campaign)).toEqual([
        expect.objectContaining({ status: 'failed', last_failure_reason: 'compose_unavailable' })
      ]);
    // The worker log carries the driver's sentence: which routine is missing,
    // and that nothing was attempted.
    for (const label of [
      'company-follow',
      'company-like',
      'company-invite',
      'event-invite',
      'group-invite',
      'group-message',
      'event-message'
    ])
      expect(
        logs.some((line) => line.includes(`no ${label} driver configured. Nothing was attempted.`)),
        label
      ).toBe(true);
  });

  it('a destination the seat cannot use settles skipped as not_found, never as sent', async () => {
    const campaign = await startCampaign(
      'Ineligible group',
      [['Hal', 'Nope', 'Acme', 'https://www.linkedin.com/in/trv014-hal/']],
      [ALL_COMMUNITY_STEPS[4]]
    );
    const calls: Call[] = [];
    const driver = fakeDriver(calls, true, () => ({
      ok: false,
      failureKind: 'not_found',
      detail: 'This seat is not eligible to invite connections from the group.'
    }));
    await drive(driver, async () => (await rows(campaign)).some((row) => row.status === 'skipped'));
    expect(calls.map((call) => call.method)).toEqual(['inviteConnectionToGroup']);
    expect(await rows(campaign)).toEqual([
      expect.objectContaining({
        kind: 'group_invite',
        status: 'skipped',
        recorded_at: null,
        failure_kind: 'not_found'
      })
    ]);
    expect(await members(campaign)).toEqual([
      expect.objectContaining({ status: 'failed', last_failure_reason: 'not_found' })
    ]);
  });
});
