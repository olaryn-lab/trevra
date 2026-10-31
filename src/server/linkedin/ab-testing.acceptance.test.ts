/**
 * TRV-019 A/B testing, end to end on real PostgreSQL with a fake driver.
 *
 * Drives the real writer (CSV import, workflow with weighted invite variants,
 * campaign, start, exact-hash approvals, outcome reports, the per-campaign
 * step editor), the managed runner's assignment, the local worker, and both
 * analytics readers. Does NOT prove the variant editor UI or live LinkedIn.
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
import { chooseMessageVariant } from './workflows.js';
import type { LinkedInDriver, LinkedInDriverResult, LinkedInPage } from './driver.js';
import type { PacedKind } from './limits.js';

let db: Db;
let app: Express;
let workspace: string;
let token: string;
let iteration = 0;

const HOUR = 3_600_000;
const T0 = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 9 * HOUR);
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function client() {
  const cookie = 'trevra_session=' + token;
  return {
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string) => request(app).post(url).set('Cookie', cookie),
    put: (url: string) => request(app).put(url).set('Cookie', cookie)
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

const leadUrl = (tag: string, i: number) => `https://www.linkedin.com/in/trv019-${tag}-${i}/`;
const leadsFor = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => [`Lead${i}`, 'Split', 'Acme', leadUrl(tag, i)]);

async function startCampaign(
  name: string,
  leads: string[][],
  steps: unknown[],
  extra: Record<string, unknown> = {}
) {
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
      .send({ name, leadListId: list.id, workflowId: workflow.id, senderKeys: ['owner'], ...extra })
      .expect(201)
  ).body.campaign;
  await http
    .post('/api/linkedin/manager/campaigns/' + campaign.id + '/start')
    .send({})
    .expect(200);
  return campaign.id as string;
}

async function approveAll(): Promise<number> {
  let total = 0;
  for (;;) {
    const reviews = (await client().get('/api/linkedin/manager/action-approvals').expect(200)).body
      .reviews as Array<{ actionId: string; contentHash: string }>;
    if (reviews.length === 0) return total;
    for (const review of reviews)
      await client()
        .post('/api/linkedin/manager/action-approvals/' + review.actionId)
        .send({ contentHash: review.contentHash })
        .expect(200);
    total += reviews.length;
  }
}

type Call = { method: string; args: unknown[] };
function fakeDriver(calls: Call[]): LinkedInDriver {
  const routine =
    (method: string) =>
    async (_page: LinkedInPage, ...args: unknown[]): Promise<LinkedInDriverResult> => {
      calls.push({ method, args });
      return { ok: true, externalRef: `ref:${method}:${String(args[0])}`, failureKind: null };
    };
  return { sendInvite: routine('sendInvite') } as unknown as LinkedInDriver;
}

function work(driver: LinkedInDriver, when: Date, maxActions = 200) {
  return runLinkedInLocalBatch(postgresLocalWorkerStore(db, workspace, 'owner'), {
    driver,
    page: {} as LinkedInPage,
    now: () => when,
    sleep: async () => {},
    log: () => {},
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
          ...(action.replayScope ? { replayScope: action.replayScope } : {})
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

interface MemberRow {
  id: string;
  profile_url: string;
  first_name: string;
  status: string;
  admitted: boolean;
  assigned_variants: Record<string, string> | string | null;
}
async function members(campaignId: string): Promise<MemberRow[]> {
  return db
    .prepare(
      `SELECT m.id, c.profile_url, c.first_name, m.status, m.admitted_at IS NOT NULL AS admitted,
              m.assigned_variants
       FROM linkedin_campaign_members m JOIN linkedin_lead_contacts c ON c.id=m.contact_id
       WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY m.id`
    )
    .all<MemberRow>(workspace, campaignId);
}
const assignedOf = (member: MemberRow) =>
  (typeof member.assigned_variants === 'string'
    ? JSON.parse(member.assigned_variants)
    : (member.assigned_variants ?? {})) as Record<string, string>;

interface ActionRow {
  id: string;
  campaign_member_id: string;
  status: string;
  body: string | null;
  variant_id: string | null;
  workflow_step_id: string | null;
}
async function rows(campaignId: string): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,campaign_member_id,status,body,variant_id,workflow_step_id
       FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? AND kind='invite'
       ORDER BY created_at,id`
    )
    .all<ActionRow>(workspace, campaignId);
}

const SPLIT = [
  { id: 'a', body: 'Hi {{first_name}}, variant A', weight: 70 },
  { id: 'b', body: 'Hello {{first_name}}, variant B', weight: 30 }
];
const inviteStep = (variants: typeof SPLIT) => ({
  id: 'invite',
  action: 'connection_request',
  config: { variants }
});
const render = (variants: typeof SPLIT, id: string, name: string) =>
  variants.find((variant) => variant.id === id)!.body.replace('{{first_name}}', name);

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  iteration++;
  workspace = 'ws_trv019_' + iteration;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  token = await session(workspace);
  await upsertSeat(
    db,
    workspace,
    {
      label: 'TRV-019 owner',
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

describe('TRV-019 A/B testing', () => {
  it('assignment is deterministic per member, holds the weights over 1000 real members, and is what the planner persists', async () => {
    const campaign = await startCampaign('Split 1000', leadsFor('k', 1000), [inviteStep(SPLIT)], {
      admissionPolicy: { maxWaveSize: 40, minWaveIntervalMinutes: 1440 }
    });
    const enrolled = await members(campaign);
    expect(enrolled).toHaveLength(1000);

    // The split over the campaign's real member ids, with the runner's own
    // seed shape (`${member.id}:${step.id}`).
    const expected = new Map(
      enrolled.map((member) => [member.id, chooseMessageVariant(SPLIT, `${member.id}:invite`).id])
    );
    const share = (map: Map<string, string>, id: string) =>
      [...map.values()].filter((value) => value === id).length / map.size;
    // 70/30 within 4 percentage points (~4 sigma at n=1000).
    expect(Math.abs(share(expected, 'a') - 0.7)).toBeLessThan(0.04);
    expect(Math.abs(share(expected, 'b') - 0.3)).toBeLessThan(0.04);
    // Deterministic: the same member always lands on the same arm.
    for (const member of enrolled)
      expect(chooseMessageVariant(SPLIT, `${member.id}:invite`).id).toBe(expected.get(member.id));
    // A three-way split over the same members also holds.
    const three = [
      { id: 'x', body: 'x', weight: 50 },
      { id: 'y', body: 'y', weight: 25 },
      { id: 'z', body: 'z', weight: 25 }
    ];
    const threeWay = new Map(
      enrolled.map((member) => [member.id, chooseMessageVariant(three, `${member.id}:invite`).id])
    );
    expect(Math.abs(share(threeWay, 'x') - 0.5)).toBeLessThan(0.05);
    expect(Math.abs(share(threeWay, 'y') - 0.25)).toBeLessThan(0.04);
    expect(Math.abs(share(threeWay, 'z') - 0.25)).toBeLessThan(0.04);

    // The planner assigns exactly that arm, renders that arm's body, and
    // persists the choice on the member.
    for (let tick = 0; tick < 3; tick++) await runManagedCampaigns(db, workspace, at(0));
    const planned = await rows(campaign);
    expect(planned).toHaveLength(40);
    const byId = new Map(enrolled.map((member) => [member.id, member]));
    const after = new Map((await members(campaign)).map((member) => [member.id, member]));
    for (const row of planned) {
      const member = byId.get(row.campaign_member_id)!;
      const arm = expected.get(member.id)!;
      expect(row).toMatchObject({
        workflow_step_id: 'invite',
        variant_id: arm,
        body: render(SPLIT, arm, member.first_name)
      });
      expect(assignedOf(after.get(member.id)!)).toEqual({ invite: arm });
    }
    // Stable across ticks: replanning passes change no assignment and add no row.
    for (let tick = 0; tick < 3; tick++) await runManagedCampaigns(db, workspace, at(1 + tick));
    expect(await rows(campaign)).toEqual(planned);
    for (const member of await members(campaign))
      if (after.get(member.id)!.admitted)
        expect(assignedOf(member)).toEqual(assignedOf(after.get(member.id)!));
  });

  it('per-variant analytics count the same population as the campaign totals and the ledger, declines included', async () => {
    const even = SPLIT.map((variant) => ({ ...variant, weight: 50 }));
    const campaign = await startCampaign('Split outcomes', leadsFor('o', 16), [inviteStep(even)]);
    const calls: Call[] = [];
    const driver = fakeDriver(calls);
    let clock = at(0);
    for (let cycle = 0; cycle < 4 && calls.length < 16; cycle++) {
      await runManagedCampaigns(db, workspace, clock);
      await approveAll();
      clock = await dueBy(clock);
      await work(driver, clock);
      clock = new Date(clock.getTime() + 10 * 60_000);
    }
    const sent = await rows(campaign);
    expect(sent.map((row) => row.status)).toEqual(Array(16).fill('sent'));
    expect(new Set(sent.map((row) => row.variant_id))).toEqual(new Set(['a', 'b']));

    // Reported outcomes: a decline and an acceptance on each arm, one reply.
    const report = async (actionId: string, outcome: string) =>
      client().post('/api/linkedin/actions/outcome').send({ actionId, outcome }).expect(200);
    for (const arm of ['a', 'b']) {
      const armRows = sent.filter((row) => row.variant_id === arm);
      await report(armRows[0].id, 'declined');
      await report(armRows[1].id, 'accepted');
    }
    await report(sent.filter((row) => row.variant_id === 'a')[2].id, 'replied');

    const ledger = await db
      .prepare(
        `SELECT variant_id,
                COUNT(*) FILTER (WHERE status IN ('sent','accepted','replied','declined'))::int AS sent,
                COUNT(*) FILTER (WHERE status IN ('accepted','replied'))::int AS accepted,
                COUNT(*) FILTER (WHERE status='replied')::int AS replied
         FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? AND kind='invite'
         GROUP BY variant_id ORDER BY variant_id`
      )
      .all<{ variant_id: string; sent: number; accepted: number; replied: number }>(
        workspace,
        campaign
      );
    const summary = (
      await client()
        .get('/api/linkedin/manager/analytics?campaignId=' + campaign)
        .expect(200)
    ).body as {
      invitesSent: number;
      variants: Array<{ variantId: string; sent: number; replied: number }>;
    };
    const operational = (
      await client()
        .get('/api/linkedin/manager/campaigns/' + campaign + '/operational-analytics')
        .expect(200)
    ).body as {
      variants: Array<{ variantId: string; sent: number; accepted: number; replied: number }>;
    };

    expect(summary.invitesSent).toBe(16);
    // The arms partition the campaign total: nothing counted in the total is
    // missing from the arms.
    expect(summary.variants.reduce((sum, variant) => sum + variant.sent, 0)).toBe(
      summary.invitesSent
    );
    expect(
      summary.variants.map(({ variantId, sent: n, replied }) => ({ variantId, sent: n, replied }))
    ).toEqual(
      ledger.map((row) => ({ variantId: row.variant_id, sent: row.sent, replied: row.replied }))
    );
    expect(
      operational.variants.map(({ variantId, sent: n, accepted, replied }) => ({
        variantId,
        sent: n,
        accepted,
        replied
      }))
    ).toEqual(
      ledger.map((row) => ({
        variantId: row.variant_id,
        sent: row.sent,
        accepted: row.accepted,
        replied: row.replied
      }))
    );
  });

  it('a mid-campaign variant edit does not reassign or resend members already given a variant', async () => {
    const campaign = await startCampaign('Split edit', leadsFor('e', 6), [inviteStep(SPLIT)], {
      admissionPolicy: { maxWaveSize: 3, minWaveIntervalMinutes: 60 }
    });
    const calls: Call[] = [];
    const driver = fakeDriver(calls);
    for (let tick = 0; tick < 3; tick++) await runManagedCampaigns(db, workspace, at(0));
    await approveAll();
    await work(driver, await dueBy(at(0)));
    const firstWave = await rows(campaign);
    expect(firstWave).toHaveLength(3);
    expect(firstWave.every((row) => row.status === 'sent')).toBe(true);
    const before = new Map((await members(campaign)).map((member) => [member.id, member]));
    const pendingIds = [...before.values()]
      .filter((member) => member.status === 'pending' && !member.admitted)
      .map((member) => member.id);
    expect(pendingIds).toHaveLength(3);

    // New bodies and inverted weights on the SAME step and variant ids.
    const edited = [
      { id: 'a', body: 'Edited {{first_name}}, variant A', weight: 1 },
      { id: 'b', body: 'Edited {{first_name}}, variant B', weight: 99 }
    ];
    const response = await client()
      .put('/api/linkedin/manager/campaigns/' + campaign + '/sequence')
      .send({ steps: [inviteStep(edited)] })
      .expect(200);
    expect(response.body.pendingAffected).toBe(3);

    let clock = at(2);
    for (let cycle = 0; cycle < 4 && calls.length < 6; cycle++) {
      await runManagedCampaigns(db, workspace, clock);
      await approveAll();
      clock = await dueBy(clock);
      await work(driver, clock);
      clock = new Date(clock.getTime() + 2 * HOUR);
    }
    await runManagedCampaigns(db, workspace, at(48));
    await work(driver, at(48));

    const all = await rows(campaign);
    const after = new Map((await members(campaign)).map((member) => [member.id, member]));
    // The first wave keeps its arm, its row and its body; nothing new for them.
    for (const row of firstWave) {
      const mine = all.filter(
        (candidate) => candidate.campaign_member_id === row.campaign_member_id
      );
      expect(mine).toEqual([{ ...row }]);
      expect(assignedOf(after.get(row.campaign_member_id)!)).toEqual({ invite: row.variant_id });
      expect(row.body).toBe(
        render(SPLIT, row.variant_id!, before.get(row.campaign_member_id)!.first_name)
      );
    }
    // The leads still pending at the edit are assigned under the edited split.
    for (const id of pendingIds) {
      const mine = all.filter((row) => row.campaign_member_id === id);
      expect(mine).toHaveLength(1);
      const arm = chooseMessageVariant(edited, `${id}:invite`).id;
      expect(mine[0]).toMatchObject({
        status: 'sent',
        variant_id: arm,
        body: render(edited, arm, after.get(id)!.first_name)
      });
      expect(assignedOf(after.get(id)!)).toEqual({ invite: arm });
    }
    // Exactly one invite per member, ever.
    expect(calls).toHaveLength(6);
    expect(new Set(calls.map((call) => call.args[0])).size).toBe(6);
  });
});
