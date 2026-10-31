/**
 * TRV-013 skill endorsements, end to end on real PostgreSQL with a fake driver.
 *
 * THE QUOTA IS PER ACTION, NOT PER CLICK. One `endorse` ledger row is one
 * endorse action on one lead; the runner budgets and the pre-send gate count
 * ROWS, and `maxSkills` (1-10, set in the workflow builder) only bounds how many
 * visible skills that one action may click. These tests pin that contract from
 * the HTTP writer to the driver call. They do not prove live LinkedIn DOM
 * behaviour (driver-engage.test.ts covers the click routine against a fake page).
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
import type { LinkedInDriver, LinkedInPage } from './driver.js';
import type { PacedKind } from './limits.js';

let db: Db;
let app: Express;
let workspace: string;
let token: string;
let iteration = 0;

const HOUR = 3_600_000;
const T0 = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 9 * HOUR);

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

const endorseStep = (maxSkills: unknown) => ({
  id: 'endorse',
  action: 'endorse_skills',
  config: maxSkills === undefined ? {} : { maxSkills }
});

async function startCampaign(name: string, handles: string[], maxSkills: number) {
  const http = client();
  const csv = [
    'First Name,Last Name,Company,LinkedIn URL',
    ...handles.map((handle) => `Lead,${handle},Acme,https://www.linkedin.com/in/${handle}/`)
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
      .send({ name: name + ' workflow', steps: [endorseStep(maxSkills)] })
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

async function approveAll() {
  const reviews = (await client().get('/api/linkedin/manager/action-approvals').expect(200)).body
    .reviews as Array<{ actionId: string; contentHash: string }>;
  for (const review of reviews)
    await client()
      .post('/api/linkedin/manager/action-approvals/' + review.actionId)
      .send({ contentHash: review.contentHash })
      .expect(200);
}

const gate = (action: {
  id: string;
  seatKey: string;
  kind: string;
  targetRef: string;
  campaignId?: string | null;
  replayScope?: string;
  at: Date;
}) =>
  evaluateLinkedInSafety(
    db,
    {
      workspaceId: workspace,
      seatKey: action.seatKey,
      kind: action.kind as PacedKind,
      targetRef: action.targetRef,
      plannedFor: action.at.toISOString(),
      ...(action.campaignId ? { campaignId: action.campaignId } : {}),
      ...(action.replayScope ? { replayScope: action.replayScope } : {})
    },
    action.at,
    { excludeActionId: action.id, dayShape: FLAT_DAY_SHAPE }
  );

function work(endorsed: Array<{ target: string; maxSkills: unknown }>, when: Date) {
  const driver = {
    endorseSkills: async (
      _page: LinkedInPage,
      target: string,
      options: { seed?: string; maxSkills?: number }
    ) => {
      endorsed.push({ target, maxSkills: options.maxSkills });
      return { ok: true, externalRef: target, failureKind: null };
    }
  } as unknown as LinkedInDriver;
  return runLinkedInLocalBatch(postgresLocalWorkerStore(db, workspace, 'owner'), {
    driver,
    page: {} as LinkedInPage,
    now: () => when,
    sleep: async () => {},
    log: () => {},
    maxActions: 25,
    evaluate: (action, instant) =>
      gate({
        id: action.id,
        seatKey: action.seatKey,
        kind: action.kind,
        targetRef: action.targetRef,
        campaignId: action.campaignId ?? null,
        ...(action.replayScope ? { replayScope: action.replayScope } : {}),
        at: instant
      }),
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

async function latestDue(floor: Date): Promise<Date> {
  const row = await db
    .prepare(
      `SELECT MAX(planned_for) AS latest FROM linkedin_actions
       WHERE workspace_id=? AND status='planned' AND claimed_at IS NULL`
    )
    .get<{ latest: string | Date | null }>(workspace);
  const latest = row?.latest ? new Date(row.latest) : floor;
  return new Date(Math.max(latest.getTime(), floor.getTime()) + 60_000);
}

async function endorseRows(campaignId: string) {
  return db
    .prepare(
      `SELECT id,status,target_ref,channel_metadata_json FROM linkedin_actions
       WHERE workspace_id=? AND campaign_id=? AND kind='endorse' ORDER BY target_ref`
    )
    .all<{
      id: string;
      status: string;
      target_ref: string;
      channel_metadata_json: Record<string, unknown> | string;
    }>(workspace, campaignId);
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  iteration++;
  workspace = 'ws_trv013_' + iteration;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  token = await session(workspace);
  // Established account: the steady endorse band (8 actions/day) applies.
  await upsertSeat(
    db,
    workspace,
    {
      label: 'TRV-013 owner',
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

describe('TRV-013 skill endorsements', () => {
  it('accepts exactly the 1-10 range the builder offers and defaults to one skill', async () => {
    for (const bad of [0, 11, 2.5, '3'])
      await client()
        .post('/api/linkedin/manager/workflows')
        .send({ name: 'bad ' + String(bad), steps: [endorseStep(bad)] })
        .expect(400);
    const defaulted = (
      await client()
        .post('/api/linkedin/manager/workflows')
        .send({ name: 'default', steps: [endorseStep(undefined)] })
        .expect(201)
    ).body.workflow;
    expect(defaulted.steps[0].config).toEqual({ maxSkills: 1 });
  });

  it('delivers the configured skill count to the driver exactly, at both bounds', async () => {
    const campaigns = new Map<number, string>();
    for (const maxSkills of [1, 7, 10])
      campaigns.set(
        maxSkills,
        await startCampaign(`Endorse ${maxSkills}`, [`trv013-n${maxSkills}`], maxSkills)
      );
    await runManagedCampaigns(db, workspace, T0);
    await approveAll();
    const endorsed: Array<{ target: string; maxSkills: unknown }> = [];
    const pass = await work(endorsed, await latestDue(T0));
    expect(pass.executed).toBe(3);
    for (const [maxSkills, campaign] of campaigns) {
      const [row] = await endorseRows(campaign);
      const metadata =
        typeof row.channel_metadata_json === 'string'
          ? JSON.parse(row.channel_metadata_json)
          : row.channel_metadata_json;
      expect(row.status).toBe('sent');
      expect(metadata).toMatchObject({ maxSkills });
      expect(endorsed.filter((call) => call.target === row.target_ref)).toEqual([
        { target: row.target_ref, maxSkills }
      ]);
    }
  });

  it('charges one quota unit per endorse action however many skills it clicks', async () => {
    const handles = Array.from({ length: 9 }, (_, index) => `trv013-q${index}`);
    const campaign = await startCampaign('Quota', handles, 10);
    await runManagedCampaigns(db, workspace, T0);
    // Planner boundary: the 8/day steady band admits and plans exactly 8
    // ten-skill actions. Per-click accounting would have planned none.
    expect((await endorseRows(campaign)).filter((row) => row.status === 'planned')).toHaveLength(8);
    await approveAll();
    const endorsed: Array<{ target: string; maxSkills: unknown }> = [];
    const when = await latestDue(T0);
    const pass = await work(endorsed, when);
    // Gate boundary: the 8th ten-skill action is still allowed at send time.
    expect(pass).toMatchObject({ executed: 8, blocked: 0 });
    expect(endorsed).toHaveLength(8);
    expect(endorsed.every((call) => call.maxSkills === 10)).toBe(true);

    // One past: a ninth endorse inside the same 24h is refused by the gate,
    // which counts 8 actions (not 80 skills) against the 8/day ceiling.
    const verdict = await gate({
      id: 'lact_not_yet_written',
      seatKey: 'owner',
      kind: 'endorse',
      targetRef: 'https://www.linkedin.com/in/trv013-q8/',
      campaignId: campaign,
      replayScope: 'probe',
      at: new Date(when.getTime() + 60_000)
    });
    expect(verdict.allowed).toBe(false);
    const ceiling = verdict.checks.find((check) => check.check === 'rolling-24h');
    expect(ceiling).toMatchObject({ passed: false });
    expect(ceiling?.detail).toContain('8 of 8 endorses');

    // The ninth lead is planned and endorsed once the window rolls over.
    const tomorrow = new Date(when.getTime() + 25 * HOUR);
    await runManagedCampaigns(db, workspace, tomorrow);
    await approveAll();
    expect((await work(endorsed, await latestDue(tomorrow))).executed).toBe(1);
    expect(new Set(endorsed.map((call) => call.target)).size).toBe(9);
  });
});
