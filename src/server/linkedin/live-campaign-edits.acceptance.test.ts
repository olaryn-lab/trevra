/**
 * TRV-017 live campaign edits, end to end on real PostgreSQL with a fake driver.
 *
 * The documented rule (managed-campaigns.ts `updateCampaignSequence`,
 * `startManagedCampaign`, `updateManagedCampaignControls`):
 *   - steps may be edited while running; pending, unadmitted members walk the
 *     new steps and admitted members keep the immutable snapshot they were
 *     admitted on, so their already-planned rows are neither re-planned nor
 *     rewritten;
 *   - schedule/sender/admission changes require a pause; pause parks unclaimed
 *     rows as 'held' and resume restores them losslessly (same id, slot, body);
 *   - every send re-checks the exact approved content hash.
 *
 * Does NOT prove the browser UI for these edits or live LinkedIn behaviour.
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
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function client() {
  const cookie = 'trevra_session=' + token;
  return {
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string) => request(app).post(url).set('Cookie', cookie),
    put: (url: string) => request(app).put(url).set('Cookie', cookie),
    patch: (url: string) => request(app).patch(url).set('Cookie', cookie)
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

type Review = { actionId: string; contentHash: string; body: string | null; targetRef: string };
async function reviews(): Promise<Review[]> {
  return (await client().get('/api/linkedin/manager/action-approvals').expect(200)).body.reviews;
}
async function approveAll(): Promise<number> {
  const pending = await reviews();
  for (const review of pending)
    await client()
      .post('/api/linkedin/manager/action-approvals/' + review.actionId)
      .send({ contentHash: review.contentHash })
      .expect(200);
  return pending.length;
}

type Call = { method: string; args: unknown[] };
function fakeDriver(
  calls: Call[],
  during: (method: string, args: unknown[]) => Promise<void> = async () => {}
): LinkedInDriver {
  const routine =
    (method: string) =>
    async (_page: LinkedInPage, ...args: unknown[]): Promise<LinkedInDriverResult> => {
      calls.push({ method, args });
      await during(method, args);
      return { ok: true, externalRef: `ref:${method}:${String(args[0])}`, failureKind: null };
    };
  return Object.fromEntries(
    ['sendInvite', 'sendDm', 'viewProfile', 'followProfile'].map((m) => [m, routine(m)])
  ) as unknown as LinkedInDriver;
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
  planned_for: string | Date | null;
  recorded_at: string | Date | null;
  workflow_step_id: string | null;
}
async function rows(campaignId: string): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,kind,status,target_ref,body,claimed_at IS NOT NULL AS claimed,planned_for,
              recorded_at,workflow_step_id
       FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? ORDER BY created_at,id`
    )
    .all<ActionRow>(workspace, campaignId);
}
async function memberStatuses(campaignId: string) {
  return db
    .prepare(
      `SELECT c.profile_url, m.status, m.admitted_at IS NOT NULL AS admitted
       FROM linkedin_campaign_members m JOIN linkedin_lead_contacts c ON c.id=m.contact_id
       WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY c.profile_url`
    )
    .all<{ profile_url: string; status: string; admitted: boolean }>(workspace, campaignId);
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  iteration++;
  workspace = 'ws_trv017_' + iteration;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  token = await session(workspace);
  logs.length = 0;
  await upsertSeat(
    db,
    workspace,
    {
      label: 'TRV-017 owner',
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

const A = 'https://www.linkedin.com/in/trv017-ana/';
const B = 'https://www.linkedin.com/in/trv017-ben/';
const C = 'https://www.linkedin.com/in/trv017-cy/';
const NAMES: Record<string, string> = { [A]: 'Ana', [B]: 'Ben', [C]: 'Cy' };

describe('TRV-017 live campaign edits', () => {
  it('a step edit mid-send leaves claimed and admitted work alone, re-holds a changed body, and never double-messages', async () => {
    const campaign = await startCampaign(
      'Live edit',
      [
        ['Ana', 'One', 'Acme', A],
        ['Ben', 'Two', 'Beta', B],
        ['Cy', 'Three', 'Gamma', C]
      ],
      [
        {
          id: 'hello',
          action: 'message',
          config: { variants: [{ id: 'a', body: 'Old hello {{first_name}}', weight: 100 }] }
        }
      ],
      // Two in sequence at a time, so the third lead is still pending (not
      // admitted) when the steps are edited.
      { admissionPolicy: { maxInSequence: 2 } }
    );
    for (let tick = 0; tick < 4 && (await rows(campaign)).length < 2; tick++)
      await runManagedCampaigns(db, workspace, at(0));
    // Which two leads the admission wave takes is the runner's choice; the
    // third stays pending and unadmitted.
    const firstPlan = await rows(campaign);
    const membersAtEdit = await memberStatuses(campaign);
    const pendingLeads = membersAtEdit.filter((m) => m.status === 'pending' && !m.admitted);
    expect(pendingLeads).toHaveLength(1);
    const P = pendingLeads[0].profile_url;
    expect(firstPlan.map((row) => [row.target_ref, row.body]).sort()).toEqual(
      [A, B, C]
        .filter((url) => url !== P)
        .map((url) => [url, `Old hello ${NAMES[url]}`])
        .sort()
    );
    expect(await approveAll()).toBe(2);
    const approvedHash = new Map(
      (
        await db
          .prepare(
            'SELECT action_id,content_hash FROM linkedin_action_approvals WHERE workspace_id=?'
          )
          .all<{ action_id: string; content_hash: string }>(workspace)
      ).map((r) => [r.action_id, r.content_hash])
    );

    // The operator edits the campaign's steps WHILE the worker is inside the
    // browser with the first lead's message (one action per batch).
    const calls: Call[] = [];
    let during: { claimed: ActionRow; waiting: ActionRow; pendingAffected: number } | null = null;
    const driver = fakeDriver(calls, async (_method, args) => {
      if (during) return;
      const now = await rows(campaign);
      const claimed = now.find((row) => row.target_ref === args[0])!;
      const waiting = now.find((row) => row.target_ref !== args[0])!;
      const edit = await client()
        .put('/api/linkedin/manager/campaigns/' + campaign + '/sequence')
        .send({
          steps: [
            {
              id: 'hello-v2',
              action: 'message',
              config: { variants: [{ id: 'b', body: 'New hello {{first_name}}', weight: 100 }] }
            }
          ]
        })
        .expect(200);
      during = { claimed, waiting, pendingAffected: edit.body.pendingAffected };
    });
    const clock = await dueBy(at(0));
    const first = await work(driver, clock, 1);
    expect(first.executed).toBe(1);
    expect(during).not.toBeNull();
    const { claimed, waiting, pendingAffected } = during!;
    // Only the pending, unadmitted lead is affected by the edit.
    expect(pendingAffected).toBe(1);
    // The claimed row was in flight during the edit and went out with the
    // bytes that were approved -- the edit did not reach into it.
    expect(claimed).toMatchObject({ claimed: true, status: 'planned' });
    expect(waiting).toMatchObject({ claimed: false, status: 'planned' });
    const firstName = NAMES[claimed.target_ref];
    const secondName = NAMES[waiting.target_ref];
    expect(calls).toEqual([
      { method: 'sendDm', args: [claimed.target_ref, `Old hello ${firstName}`, expect.any(Object)] }
    ]);
    let now = await rows(campaign);
    expect(now.find((row) => row.id === claimed.id)).toMatchObject({
      status: 'sent',
      body: `Old hello ${firstName}`
    });
    // The admitted lead's planned-but-unclaimed row is neither re-planned nor
    // rewritten: same id, same slot, same approved body and hash.
    const stillWaiting = now.find((row) => row.id === waiting.id)!;
    expect(stillWaiting).toMatchObject({
      status: 'planned',
      claimed: false,
      body: `Old hello ${secondName}`,
      workflow_step_id: 'hello'
    });
    expect(new Date(stillWaiting.planned_for!).getTime()).toBe(
      new Date(waiting.planned_for!).getTime()
    );
    expect((await reviews()).map((review) => review.actionId)).not.toContain(waiting.id);

    // The approved row's body then changes underneath its approval (the same
    // UPDATE an applied AI draft performs, ai-drafts.ts). The exact-hash
    // approval no longer matches: the send is held, nothing reaches LinkedIn.
    await db
      .prepare('UPDATE linkedin_actions SET body=? WHERE workspace_id=? AND id=?')
      .run(`Rewritten for ${secondName}`, workspace, waiting.id);
    const held = await work(driver, at(1));
    expect(held).toMatchObject({ executed: 0, blocked: 1 });
    expect(calls).toHaveLength(1);
    expect(
      logs.some(
        (line) =>
          line.includes(`held action ${waiting.id}`) &&
          line.includes('must approve the exact dm action')
      )
    ).toBe(true);
    const again = (await reviews()).find((review) => review.actionId === waiting.id)!;
    expect(again).toMatchObject({ body: `Rewritten for ${secondName}` });
    expect(again.contentHash).not.toBe(approvedHash.get(waiting.id));
    // The stale approval cannot be replayed against the new bytes.
    const stale = await client()
      .post('/api/linkedin/manager/action-approvals/' + waiting.id)
      .send({ contentHash: approvedHash.get(waiting.id) });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    await client()
      .post('/api/linkedin/manager/action-approvals/' + waiting.id)
      .send({ contentHash: again.contentHash })
      .expect(200);
    expect((await work(driver, at(1))).executed).toBe(1);
    expect(calls[1]).toEqual({
      method: 'sendDm',
      args: [waiting.target_ref, `Rewritten for ${secondName}`, expect.any(Object)]
    });

    // The pending lead is admitted later and walks the NEW steps; the two
    // admitted leads finish on their snapshot and never get the new message.
    let clockLater = at(2);
    for (let cycle = 0; cycle < 8; cycle++) {
      await runManagedCampaigns(db, workspace, clockLater);
      await approveAll();
      clockLater = await dueBy(clockLater);
      await work(driver, clockLater);
      clockLater = new Date(clockLater.getTime() + 10 * 60_000);
      if ((await memberStatuses(campaign)).every((m) => m.status === 'completed')) break;
    }
    await runManagedCampaigns(db, workspace, at(48));
    await work(driver, at(48));
    expect((await memberStatuses(campaign)).map((m) => m.status)).toEqual([
      'completed',
      'completed',
      'completed'
    ]);
    now = await rows(campaign);
    expect(
      now.map((row) => [row.target_ref, row.workflow_step_id, row.status, row.body]).sort()
    ).toEqual(
      [
        [claimed.target_ref, 'hello', 'sent', `Old hello ${firstName}`],
        [waiting.target_ref, 'hello', 'sent', `Rewritten for ${secondName}`],
        [P, 'hello-v2', 'sent', `New hello ${NAMES[P]}`]
      ].sort()
    );
    // Exactly one message per member, ever.
    expect(calls.map((call) => call.args[0]).sort()).toEqual([A, B, C].sort());
  });

  it('a schedule edit made while paused is honoured by rows resume restores with their old slots', async () => {
    const weekday = T0.getUTCDay();
    const campaign = await startCampaign(
      'Reschedule',
      [['Eve', 'Later', 'Delta', 'https://www.linkedin.com/in/trv017-eve/']],
      [{ id: 'invite', action: 'connection_request', config: {} }]
    );
    await runManagedCampaigns(db, workspace, at(0));
    expect(await approveAll()).toBe(1);
    const [planned] = await rows(campaign);
    expect(planned).toMatchObject({ status: 'planned', claimed: false });
    const slot = new Date(planned.planned_for!);
    expect(slot.getTime()).toBeLessThan(at(1).getTime());

    const schedule = {
      workingDays: [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== weekday),
      workStartMinute: 13 * 60,
      workEndMinute: 17 * 60
    };
    // Schedule edits require a pause.
    const running = await client()
      .patch('/api/linkedin/manager/campaigns/' + campaign + '/controls')
      .send({ schedule });
    expect(running.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(running.body)).toContain('Pause the campaign');

    await client()
      .post('/api/linkedin/manager/campaigns/' + campaign + '/pause')
      .send({})
      .expect(200);
    expect((await rows(campaign))[0]).toMatchObject({ id: planned.id, status: 'held' });
    await client()
      .patch('/api/linkedin/manager/campaigns/' + campaign + '/controls')
      .send({ schedule })
      .expect(200);
    await client()
      .post('/api/linkedin/manager/campaigns/' + campaign + '/start')
      .send({})
      .expect(200);
    // Resume is lossless: same row, same (now out-of-schedule) slot, still approved.
    const restored = (await rows(campaign))[0];
    expect(restored).toMatchObject({ id: planned.id, status: 'planned', claimed: false });
    expect(new Date(restored.planned_for!).getTime()).toBe(slot.getTime());
    expect(await reviews()).toEqual([]);

    const calls: Call[] = [];
    const driver = fakeDriver(calls);
    // 09:30 on the excluded day, inside the seat's window: refused.
    expect(await work(driver, at(0.5))).toMatchObject({ executed: 0, blocked: 1 });
    // 13:30 on the excluded day: hours fit, the day does not. Refused.
    expect(await work(driver, at(4.5))).toMatchObject({ executed: 0, blocked: 1 });
    expect(calls).toEqual([]);
    expect((await rows(campaign))[0]).toMatchObject({ status: 'planned', claimed: false });
    expect(logs.some((line) => line.includes('campaign schedule'))).toBe(true);
    // 10:00 the next day: the day fits, the hours do not. Refused.
    expect(await work(driver, at(25))).toMatchObject({ executed: 0, blocked: 1 });
    // 13:30 the next day: inside the edited schedule. Sent exactly once.
    expect(await work(driver, at(28.5))).toMatchObject({ executed: 1, blocked: 0 });
    expect(calls.map((call) => call.method)).toEqual(['sendInvite']);
    expect((await rows(campaign))[0]).toMatchObject({ id: planned.id, status: 'sent' });
  });
});
