/**
 * Controlled-provider Trevra MVP acceptance. Does not prove live LinkedIn, mailbox
 * connection, DNS, companion pairing, browser rendering, or staging deployment.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
const provider = vi.hoisted(() => ({
  post: vi.fn(async () => ({
    data: { id: 'test-mvp-email', threadId: 'test-thread' },
    headers: {}
  })),
  get: vi.fn(async () => ({
    data: { payload: { headers: [{ name: 'Message-ID', value: '<mvp@testing.invalid>' }] } },
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    post = provider.post;
    get = provider.get;
  }
}));
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from '../email/compliance.js';
import { createSuppression, findSuppression } from '../suppressions.js';
import { runManagedCampaigns } from './runner.js';
import { postgresLocalWorkerStore, runLinkedInLocalBatch } from './local-worker.js';
import { linkedinActionPolicyGate } from './action-policy.js';
import { recordCampaignEmailEvent, runCampaignChannelActions } from './campaign-channels.js';
import { upsertSeat } from './seats.js';
import type { LinkedInDriver, LinkedInPage } from './driver.js';

let db: Db;
let app: Express;
let workspace: string;
let tenantB: string;
let tokenA: string;
let tokenB: string;
let iteration = 0;
const plusHours = (at: Date, hours: number) => new Date(at.getTime() + hours * 3600000);
function as(token: string) {
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
const emailStep = {
  id: 'email',
  action: 'email',
  delayBefore: { amount: 0, unit: 'hours' },
  config: {
    subject: 'Hello {{company}}',
    variants: [{ id: 'a', body: 'Hello {{first_name}} at {{company}}', weight: 100 }],
    tracking: 'off',
    threaded: false
  }
};
const inviteStep = {
  id: 'invite',
  action: 'connection_request',
  delayBefore: { amount: 0, unit: 'hours' },
  config: { message: 'Hello {{first_name}} at {{company}}' }
};
async function campaign(name: string, csv: string, steps: unknown[]) {
  const client = as(tokenA);
  const list = (
    await client
      .post('/api/linkedin/manager/lead-lists')
      .send({ name: name + ' list', sourceKind: 'csv' })
      .expect(201)
  ).body.list;
  const file = Buffer.from(csv);
  const preview = (
    await client
      .post('/api/linkedin/manager/lead-lists/preview')
      .attach('file', file, { filename: 'leads.csv', contentType: 'text/csv' })
      .expect(200)
  ).body;
  const imported = (
    await client
      .post('/api/linkedin/manager/lead-lists/' + list.id + '/import')
      .attach('file', file, { filename: 'leads.csv', contentType: 'text/csv' })
      .expect(201)
  ).body;
  const workflow = (
    await client
      .post('/api/linkedin/manager/workflows')
      .send({ name: name + ' workflow', steps })
      .expect(201)
  ).body.workflow;
  const created = (
    await client
      .post('/api/linkedin/manager/campaigns')
      .send({
        name,
        leadListId: list.id,
        workflowId: workflow.id,
        senderKeys: ['owner'],
        mailboxAssignments: { owner: 'conn_' + workspace }
      })
      .expect(201)
  ).body.campaign;
  return { list, preview, imported, created };
}
beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  iteration++;
  workspace = 'ws_launch_acceptance_' + iteration;
  tenantB = 'ws_launch_other_' + iteration;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  tokenA = await session(workspace);
  tokenB = await session(tenantB);
  await upsertSeat(
    db,
    workspace,
    {
      label: 'Mocked companion owner',
      timezone: 'UTC',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workStartMinute: 0,
      workEndMinute: 1440
    },
    new Date()
  );
  vi.stubEnv('NANGO_API_KEY', 'controlled-test-only');
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://trevra.test');
  registerEmailComplianceProvider({
    footer: async () =>
      'Acme, 1 Market St\nPrivacy: https://acme.test/privacy\n' + OUTREACH_OPT_OUT_SENTENCE,
    blockers: async () => []
  });
  await db
    .prepare(
      "INSERT INTO connections(id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,mailbox_address,created_at,updated_at) VALUES (?,?,'gmail','trevra-gmail','test-mailbox','Fake mailbox','connected',0,'founder@acme.test',now(),now())"
    )
    .run('conn_' + workspace, workspace);
  await db
    .prepare(
      "INSERT INTO email_inbound_mailboxes(workspace_id,connection_id,address,sync_status,designated_at,updated_at) VALUES (?,?,'founder@acme.test','syncing',now(),now())"
    )
    .run(workspace, 'conn_' + workspace);
  const pass = JSON.stringify({ status: 'pass', detail: 'test fixture', record: null });
  await db
    .prepare(
      "INSERT INTO email_deliverability_checks(workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,checked_at,expires_at) VALUES (?,'acme.test','google','pass',?::jsonb,?::jsonb,?::jsonb,'[]'::jsonb,'[]'::jsonb,now(),now()+interval '10 years')"
    )
    .run(workspace, pass, pass, pass);
});
afterEach(async () => {
  resetEmailComplianceProvider();
  vi.unstubAllEnvs();
  provider.post.mockReset();
  provider.post.mockResolvedValue({
    data: { id: 'test-mvp-email', threadId: 'test-thread' },
    headers: {}
  });
  provider.get.mockClear();
  await db?.close();
});

describe('first customer L3–L6 acceptance with provider doubles and isolated PostgreSQL', () => {
  it('requires an explicit, audited operator verification before retrying an unknown LinkedIn send', async () => {
    const client = as(tokenA);
    const data = await campaign(
      'Unknown-send safety',
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Chen,Acme,https://www.linkedin.com/in/trevra-unknown-maya/',
      [inviteStep]
    );
    await client
      .post('/api/linkedin/manager/campaigns/' + data.created.id + '/start')
      .send({})
      .expect(200);
    await runManagedCampaigns(db, workspace, plusHours(new Date(), 2));
    const action = await db
      .prepare(`SELECT id FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? LIMIT 1`)
      .get<{ id: string }>(workspace, data.created.id);
    expect(action).toBeDefined();
    await db
      .prepare(
        `UPDATE linkedin_actions SET claimed_at=now(), settlement_hold_at=now(),
         failure_kind='unknown' WHERE workspace_id=? AND id=?`
      )
      .run(workspace, action!.id);
    const url = '/api/linkedin/manager/actions/' + action!.id + '/resolve';
    // The historical one-click UI/API request MUST NOT lift quarantine.
    await client.post(url).send({ resolution: 'retry' }).expect(400);
    await client
      .post(url)
      .send({
        resolution: 'retry',
        verifiedNotSent: false,
        verificationMethod: 'linkedin_sent_items'
      })
      .expect(400);
    await client
      .post(url)
      .send({
        resolution: 'retry',
        verifiedNotSent: true,
        verificationMethod: 'unknown'
      })
      .expect(400);
    await as(tokenB)
      .post(url)
      .send({
        resolution: 'retry',
        verifiedNotSent: true,
        verificationMethod: 'linkedin_sent_items'
      })
      .expect(404);
    const before = await db
      .prepare(`SELECT settlement_hold_at IS NOT NULL AS held FROM linkedin_actions WHERE id=?`)
      .get<{ held: boolean }>(action!.id);
    expect(before?.held).toBe(true);
    await client
      .post(url)
      .send({
        resolution: 'retry',
        verifiedNotSent: true,
        verificationMethod: 'linkedin_sent_items'
      })
      .expect(200, { resolved: true });
    const after = await db
      .prepare(
        `SELECT settlement_hold_at IS NOT NULL AS held, status FROM linkedin_actions WHERE id=?`
      )
      .get<{ held: boolean; status: string }>(action!.id);
    expect(after).toMatchObject({ held: false, status: 'planned' });
    const audit = await db
      .prepare(
        `SELECT metadata_json FROM audit_events
       WHERE workspace_id=? AND event_type='linkedin_campaign_member.unknown_outcome_resolved'
       ORDER BY created_at DESC LIMIT 1`
      )
      .get<{
        metadata_json: { resolution: string; verifiedNotSent: boolean; verificationMethod: string };
      }>(workspace);
    const recorded =
      typeof audit?.metadata_json === 'string'
        ? JSON.parse(audit.metadata_json)
        : audit?.metadata_json;
    expect(recorded).toMatchObject({
      resolution: 'retry',
      verifiedNotSent: true,
      verificationMethod: 'linkedin_sent_items'
    });
    // No browser or provider was called by reconciliation; it only makes the
    // now-owner-verified action eligible for its usual deterministic gates.
    expect(provider.post).not.toHaveBeenCalled();
  });

  it('links the real API, CSV, personalized approvals, worker ledgers, reply stop, and campaign controls', async () => {
    const now = new Date();
    const client = as(tokenA);
    const csv = [
      'First Name,Last Name,Company,Email,LinkedIn URL',
      'Maya,Chen,Acme,MAYA@EXAMPLE.COM,https://www.linkedin.com/in/trevra-mvp-maya/?trk=source',
      'Maya,Chen,Acme,maya@example.com,https://linkedin.com/in/trevra-mvp-maya/',
      'Jon,Lee,Beta,jon@example.com,https://linkedin.com/in/trevra-mvp-jon/'
    ].join('\n');
    const data = await campaign('Launch journey', csv, [inviteStep, emailStep]);
    expect(data.preview.acceptedCount).toBe(2);
    expect(data.imported.inserted).toBe(2);
    expect(data.imported.rejected).toHaveLength(1);
    expect(data.created.status).toBe('draft');
    const id = data.created.id as string;
    const leads = (
      await client.get('/api/linkedin/manager/lead-lists/' + data.list.id + '/contacts').expect(200)
    ).body.contacts;
    expect(leads).toHaveLength(2);
    expect(leads.find((x: { firstName: string }) => x.firstName === 'Maya').email).toBe(
      'maya@example.com'
    );
    await as(tokenB)
      .get('/api/linkedin/manager/campaigns/' + id)
      .expect(404);
    await request(app)
      .get('/api/linkedin/manager/campaigns/' + id)
      .expect(401);
    await client
      .post('/api/linkedin/manager/campaigns/' + id + '/start')
      .send({})
      .expect(200);
    await runManagedCampaigns(db, workspace, plusHours(now, 2));

    const reviews = (await client.get('/api/linkedin/manager/action-approvals').expect(200)).body
      .reviews;
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].body).toMatch(/Hello (Maya|Jon) at (Acme|Beta)/);
    await as(tokenB)
      .post('/api/linkedin/manager/action-approvals/' + reviews[0].actionId)
      .send({ contentHash: reviews[0].contentHash })
      .expect(404);
    await client
      .post('/api/linkedin/manager/action-approvals/' + reviews[0].actionId)
      .send({ contentHash: '0'.repeat(64) })
      .expect(409);

    const browserCalls: string[] = [];
    const worker = (when: Date) =>
      runLinkedInLocalBatch(postgresLocalWorkerStore(db, workspace, 'owner'), {
        driver: {
          sendInvite: async (_page: LinkedInPage, target: string) => {
            browserCalls.push(target);
            return {
              ok: true,
              externalRef: 'test-linkedin-action-' + browserCalls.length,
              failureKind: null
            };
          }
        } as LinkedInDriver,
        page: {} as LinkedInPage,
        now: () => when,
        sleep: async () => {},
        log: () => {},
        maxActions: 5,
        evaluate: async () => ({
          allowed: true,
          reason: null,
          checks: [],
          automationMode: 'prepare-only',
          automationReason: 'Provider double; not live safety acceptance'
        }),
        authorizeAction: (a) => linkedinActionPolicyGate(db, workspace, a.id)
      });
    const blocked = await worker(plusHours(now, 3));
    expect(blocked.executed).toBe(0);
    expect(browserCalls).toHaveLength(0);
    for (const review of reviews) {
      await client
        .post('/api/linkedin/manager/action-approvals/' + review.actionId)
        .send({ contentHash: review.contentHash })
        .expect(200);
    }
    const executed = await worker(plusHours(now, 3));
    expect(executed.executed).toBeGreaterThan(0);
    expect(browserCalls).toHaveLength(executed.executed);
    expect((await worker(plusHours(now, 3))).executed).toBe(0);

    await runManagedCampaigns(db, workspace, plusHours(now, 24));
    const reviewsUrl = '/api/linkedin/manager/campaigns/' + id + '/email-approvals';
    const mailReviews = (await client.get(reviewsUrl).expect(200)).body.reviews;
    expect(mailReviews.length).toBeGreaterThan(0);
    expect(mailReviews[0].body).toMatch(/Hello (Maya|Jon) at (Acme|Beta)/);
    expect(mailReviews[0]).toMatchObject({
      approved: false,
      policy: { effect: 'require_approval' }
    });
    expect((await runCampaignChannelActions(db, workspace, plusHours(now, 25))).sent).toBe(0);
    expect(provider.post).not.toHaveBeenCalled();
    await client
      .post(reviewsUrl + '/' + mailReviews[0].actionId)
      .send({ contentHash: '0'.repeat(64) })
      .expect(409);
    for (const review of mailReviews) {
      await client
        .post(reviewsUrl + '/' + review.actionId)
        .send({ contentHash: review.contentHash })
        .expect(200);
    }
    const run = await runCampaignChannelActions(db, workspace, plusHours(now, 26));
    expect(run.sent).toBeGreaterThan(0);
    expect(provider.post).toHaveBeenCalledTimes(run.sent);
    expect((await runCampaignChannelActions(db, workspace, plusHours(now, 27))).sent).toBe(0);
    const mailed = await db
      .prepare(
        "SELECT id,status,outcome_known FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND status='sent' ORDER BY id"
      )
      .all<{ id: string; status: string; outcome_known: boolean }>(workspace, id);
    expect(mailed[0]).toMatchObject({ status: 'sent', outcome_known: true });
    expect(
      await recordCampaignEmailEvent(db, workspace, {
        channelActionId: mailed[0].id,
        eventKind: 'reply',
        providerEventId: 'mvp-reply-1'
      })
    ).toMatchObject({ recorded: true });
    expect(
      await recordCampaignEmailEvent(db, workspace, {
        channelActionId: mailed[0].id,
        eventKind: 'reply',
        providerEventId: 'mvp-reply-1'
      })
    ).toMatchObject({ recorded: false });
    expect(
      (await client.get('/api/linkedin/manager/campaigns/' + id).expect(200)).body.members.some(
        (member: { status: string }) => member.status === 'replied'
      )
    ).toBe(true);
    const count = provider.post.mock.calls.length;
    await runManagedCampaigns(db, workspace, plusHours(now, 28));
    await runCampaignChannelActions(db, workspace, plusHours(now, 29));
    expect(provider.post).toHaveBeenCalledTimes(count);

    // With no redundant campaign-day ramp the two-lead journey can complete
    // before its lifecycle controls are exercised. Verify pause/resume/stop on
    // a fresh, explicitly running campaign instead of trying to pause one
    // which has already completed legitimately.
    const controls = await campaign(
      'Lifecycle controls',
      'First Name,Last Name,Company,Email,LinkedIn URL\nControl,Person,Acme,control@example.com,https://linkedin.com/in/trevra-mvp-control/',
      [inviteStep]
    );
    const controlId = controls.created.id as string;
    await client
      .post('/api/linkedin/manager/campaigns/' + controlId + '/start')
      .send({})
      .expect(200);
    await client
      .post('/api/linkedin/manager/campaigns/' + controlId + '/pause')
      .send({})
      .expect(200);
    expect(
      (await client.get('/api/linkedin/manager/campaigns/' + controlId).expect(200)).body.campaign
        .status
    ).toBe('paused');
    await client
      .post('/api/linkedin/manager/campaigns/' + controlId + '/start')
      .send({})
      .expect(200);
    expect(
      (await client.get('/api/linkedin/manager/campaigns/' + controlId).expect(200)).body.campaign
        .status
    ).toBe('running');
    await client
      .post('/api/linkedin/manager/campaigns/' + controlId + '/stop')
      .send({})
      .expect(200);
    expect(
      (await client.get('/api/linkedin/manager/campaigns/' + controlId).expect(200)).body.campaign
        .status
    ).toBe('stopped');
  });

  it('quarantines uncertain provider outcomes and refuses replay or tenant access', async () => {
    const now = new Date();
    const one = await campaign(
      'Unknown outcome',
      'First Name,Last Name,Company,Email,LinkedIn URL\nPat,Lee,Acme,pat@example.com,https://linkedin.com/in/mvp-pat/',
      [emailStep, inviteStep]
    );
    const path = '/api/linkedin/manager/campaigns/' + one.created.id;
    await as(tokenA)
      .post(path + '/start')
      .send({})
      .expect(200);
    await runManagedCampaigns(db, workspace, plusHours(now, 2));
    const review = (
      await as(tokenA)
        .get(path + '/email-approvals')
        .expect(200)
    ).body.reviews[0];
    expect(review).toBeDefined();
    await as(tokenB)
      .get(path + '/email-approvals')
      .expect(404);
    await as(tokenB)
      .post(path + '/email-approvals/' + review.actionId)
      .send({ contentHash: review.contentHash })
      .expect(404);
    await as(tokenA)
      .post(path + '/email-approvals/' + review.actionId)
      .send({ contentHash: review.contentHash })
      .expect(200);
    provider.post.mockRejectedValueOnce(new Error('connection closed after provider acceptance'));
    expect((await runCampaignChannelActions(db, workspace, plusHours(now, 3))).unknown).toBe(1);
    const state = await db
      .prepare(
        'SELECT status,outcome_known FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=?'
      )
      .get<{ status: string; outcome_known: boolean }>(workspace, review.actionId);
    expect(state).toMatchObject({ status: 'unknown', outcome_known: false });
    expect((await runCampaignChannelActions(db, workspace, plusHours(now, 4))).sent).toBe(0);
    expect(provider.post).toHaveBeenCalledTimes(1);

    await createSuppression(db, {
      workspaceId: workspace,
      channel: 'email',
      email: 'pat@example.com',
      reason: 'Never Contact',
      source: 'manual'
    });
    expect(
      await findSuppression(db, workspace, { channel: 'email', email: 'pat@example.com' })
    ).not.toBeNull();
    await runCampaignChannelActions(db, workspace, plusHours(now, 5));
    expect(provider.post).toHaveBeenCalledTimes(1);
  });

  it('records unsubscribe and hard bounce and retires already planned LinkedIn follow-ups', async () => {
    const now = new Date();
    const csv = [
      'First Name,Last Name,Company,Email,LinkedIn URL',
      'Usha,Optout,Acme,usha@example.com,https://linkedin.com/in/mvp-usha/',
      'Bo,Bounce,Beta,bo@example.com,https://linkedin.com/in/mvp-bo/'
    ].join('\n');
    const created = await campaign('Bounce and unsubscribe safety', csv, [emailStep, inviteStep]);
    const url = '/api/linkedin/manager/campaigns/' + created.created.id;
    await as(tokenA)
      .post(url + '/start')
      .send({})
      .expect(200);
    await runManagedCampaigns(db, workspace, plusHours(now, 2));
    let reviews = (
      await as(tokenA)
        .get(url + '/email-approvals')
        .expect(200)
    ).body.reviews;
    // Wave admission is deliberately capacity-paced; qualify both leads across successive days.
    for (let day = 1; day <= 7 && reviews.length < 2; day++) {
      await runManagedCampaigns(db, workspace, plusHours(now, 24 * day + 2));
      reviews = (
        await as(tokenA)
          .get(url + '/email-approvals')
          .expect(200)
      ).body.reviews;
    }
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      await as(tokenA)
        .post(url + '/email-approvals/' + review.actionId)
        .send({ contentHash: review.contentHash })
        .expect(200);
    }
    expect((await runCampaignChannelActions(db, workspace, plusHours(now, 24 * 9))).sent).toBe(2);
    expect(provider.post).toHaveBeenCalledTimes(2);
    await runManagedCampaigns(db, workspace, plusHours(now, 24 * 10));
    const before = await db
      .prepare(
        "SELECT id,campaign_member_id,status FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? AND kind='invite' ORDER BY id"
      )
      .all<{
        id: string;
        campaign_member_id: string;
        status: string;
      }>(workspace, created.created.id);
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.status === 'planned')).toBe(true);
    const sent = await db
      .prepare(
        "SELECT a.id,c.email FROM linkedin_campaign_channel_actions a JOIN linkedin_lead_contacts c ON a.workspace_id=c.workspace_id AND a.contact_id=c.id WHERE a.workspace_id=? AND a.campaign_id=? AND a.status='sent'"
      )
      .all<{ id: string; email: string }>(workspace, created.created.id);
    for (const row of sent) {
      const kind = row.email === 'usha@example.com' ? 'unsubscribe' : 'bounce';
      const event = await recordCampaignEmailEvent(db, workspace, {
        channelActionId: row.id,
        eventKind: kind,
        providerEventId: 'mvp-' + kind
      });
      expect(event.recorded).toBe(true);
      expect(
        (
          await recordCampaignEmailEvent(db, workspace, {
            channelActionId: row.id,
            eventKind: kind,
            providerEventId: 'mvp-' + kind
          })
        ).recorded
      ).toBe(false);
      expect(
        await findSuppression(db, workspace, { channel: 'email', email: row.email })
      ).not.toBeNull();
    }
    const after = await db
      .prepare(
        "SELECT status FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? AND kind='invite'"
      )
      .all<{ status: string }>(workspace, created.created.id);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.status === 'skipped')).toBe(true);
    const detail = (await as(tokenA).get(url).expect(200)).body;
    expect(detail.members.map((m: { status: string }) => m.status)).toEqual([
      'excluded',
      'excluded'
    ]);
    expect((await runCampaignChannelActions(db, workspace, plusHours(now, 25))).sent).toBe(0);
    expect(provider.post).toHaveBeenCalledTimes(2);
  });

  it('records definite provider failure and skips a newly suppressed recipient before side effects', async () => {
    const now = new Date();
    const bad = await campaign(
      'Definite error',
      'First Name,Last Name,Company,Email,LinkedIn URL\nFail,Send,Acme,fail@example.com,https://linkedin.com/in/mvp-fail/',
      [emailStep]
    );
    const url = '/api/linkedin/manager/campaigns/' + bad.created.id;
    await as(tokenA)
      .post(url + '/start')
      .send({})
      .expect(200);
    await runManagedCampaigns(db, workspace, plusHours(now, 2));
    const review = (
      await as(tokenA)
        .get(url + '/email-approvals')
        .expect(200)
    ).body.reviews[0];
    await as(tokenA)
      .post(url + '/email-approvals/' + review.actionId)
      .send({ contentHash: review.contentHash })
      .expect(200);
    // Provider double returns a definitely rejected request (not a network timeout).
    provider.post.mockRejectedValueOnce(new Error('HTTP 400 invalid recipient'));
    const failed = await runCampaignChannelActions(db, workspace, plusHours(now, 3));
    expect(failed.failed).toBe(1);
    expect(failed.unknown).toBe(0);
    expect(
      await db
        .prepare(
          'SELECT status,outcome_known FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=?'
        )
        .get<{ status: string; outcome_known: boolean }>(workspace, review.actionId)
    ).toMatchObject({ status: 'failed', outcome_known: true });
    expect(
      (
        await recordCampaignEmailEvent(db, workspace, {
          channelActionId: review.actionId,
          eventKind: 'reply',
          providerEventId: 'fabricated-unsent-reply'
        })
      ).recorded
    ).toBe(false);
    await runCampaignChannelActions(db, workspace, plusHours(now, 4));
    expect(provider.post).toHaveBeenCalledTimes(1);

    const blocked = await campaign(
      'Do not contact before send',
      'First Name,Last Name,Company,Email,LinkedIn URL\nNo,Contact,Beta,never@example.com,https://linkedin.com/in/mvp-never/',
      [emailStep]
    );
    const blockedUrl = '/api/linkedin/manager/campaigns/' + blocked.created.id;
    await as(tokenA)
      .post(blockedUrl + '/start')
      .send({})
      .expect(200);
    await runManagedCampaigns(db, workspace, plusHours(now, 5));
    const pending = (
      await as(tokenA)
        .get(blockedUrl + '/email-approvals')
        .expect(200)
    ).body.reviews[0];
    expect(pending).toBeDefined();
    await as(tokenA)
      .post(blockedUrl + '/email-approvals/' + pending.actionId)
      .send({ contentHash: pending.contentHash })
      .expect(200);
    await createSuppression(db, {
      workspaceId: workspace,
      channel: 'all',
      email: 'never@example.com',
      reason: 'Never Contact',
      source: 'operator'
    });
    const refused = await runCampaignChannelActions(db, workspace, plusHours(now, 6));
    expect(refused.sent).toBe(0);
    expect(provider.post).toHaveBeenCalledTimes(1);
    expect((await as(tokenA).get(blockedUrl).expect(200)).body.members[0].status).toBe('excluded');
    expect(
      await db
        .prepare(
          'SELECT status FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=?'
        )
        .get<{ status: string }>(workspace, pending.actionId)
    ).toMatchObject({ status: 'skipped' });
  });
});
