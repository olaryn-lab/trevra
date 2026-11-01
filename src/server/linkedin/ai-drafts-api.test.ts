import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { setAgentBudget } from '../agent/budget.js';
import { putWorkspaceAgentConfig, putWorkspaceSecret } from '../secrets/store.js';
import { recordAction } from './actions.js';
import { reviewLinkedInAction } from './action-policy.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  createManagedCampaign,
  listCampaignMembers,
  startManagedCampaign
} from './managed-campaigns.js';
import { runManagedCampaigns } from './runner.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

const NOW = new Date('2026-10-30T09:00:00.000Z');
const FOREIGN = 'ws_ai_drafts_api_foreign';
const DRAFT =
  'Maya, Acme posted three SDR roles this month. Open to a 2-minute teardown of how Acme books demos?';
const API_KEY = 'sk-ai-drafts-api-THE-WORKSPACE-KEY-4242';
const STEPS = [
  {
    id: 'invite',
    action: 'connection_request',
    delayBefore: { amount: 0, unit: 'hours' },
    config: {
      variants: [
        {
          id: 'inv-a',
          body: 'Hi {{first_name}}, {{company}} is hiring SDRs. Open to connect?',
          weight: 50
        }
      ]
    }
  },
  {
    id: 'end',
    action: 'end',
    delayBefore: { amount: 0, unit: 'hours' },
    config: { outcome: 'completed' }
  }
];

let db: Db;
let app: Express;
let modelServer: Server;
let modelRequests = 0;
let foreignToken = '';
const workspaces: string[] = [FOREIGN];
let seq = 0;

async function signUp(label: string) {
  seq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${seq}@ai-drafts-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'ai-drafts-api-password-1', name: label })
    .expect(200);
  const session = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    workspaceId: string;
  };
  return { agent, userId: response.body.user.id as string, workspaceId: session.workspaceId };
}

/** A legacy cookie session: the only user, and so the owner, of its own workspace. */
async function legacySession(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, workspaceId, NOW.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(userId, workspaceId, `${userId}@trevra.test`, workspaceId, NOW.toISOString());
  const token = randomBytes(24).toString('base64url');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW.toISOString()
    );
  return token;
}

/** One running campaign whose single lead has a queued invite. */
async function campaignWithInvite(workspaceId: string, handle: string) {
  await upsertSeat(
    db,
    workspaceId,
    { label: 'Owner', timezone: 'Europe/Zurich' },
    new Date('2026-01-01T09:00:00Z')
  );
  const profile = `https://www.linkedin.com/in/${handle}/`;
  const list = await createLeadList(db, { workspaceId, name: `API leads ${handle}` }, NOW);
  await importLeadCsv(
    db,
    {
      workspaceId,
      listId: list.id,
      csv: `First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Review,Acme,${handle}@example.com,${profile}\n`
    },
    NOW
  );
  const workflow = await saveWorkflow(
    db,
    {
      workspaceId,
      name: `API flow ${handle}`,
      steps: [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ]
    },
    NOW
  );
  const created = await createManagedCampaign(
    db,
    {
      workspaceId,
      name: `API campaign ${handle}`,
      leadListId: list.id,
      workflowId: workflow.id,
      admissionPolicy: { maxWaveSize: 10 }
    },
    NOW
  );
  const campaignId = created.campaign.id;
  await startManagedCampaign(db, workspaceId, campaignId, NOW);
  await runManagedCampaigns(db, workspaceId, NOW);
  const member = (await listCampaignMembers(db, workspaceId, campaignId))[0]!;
  const snapshot = JSON.stringify({ steps: STEPS });
  await db
    .prepare('UPDATE linkedin_campaigns SET sequence_json=?::jsonb WHERE workspace_id=? AND id=?')
    .run(snapshot, workspaceId, campaignId);
  await db
    .prepare('UPDATE linkedin_campaign_members SET workflow_snapshot_json=?::jsonb WHERE id=?')
    .run(snapshot, member.id);
  const invite = await recordAction(
    db,
    {
      workspaceId,
      kind: 'invite',
      targetRef: profile,
      campaignId,
      status: 'planned',
      source: 'campaign',
      plannedFor: NOW.toISOString(),
      replayScope: `${member.id}:invite`
    },
    NOW
  );
  await db
    .prepare(
      `UPDATE linkedin_actions SET body=?,campaign_member_id=?,workflow_step_id='invite',variant_id='inv-a'
        WHERE workspace_id=? AND id=?`
    )
    .run('Queued invite for Maya at Acme', member.id, workspaceId, invite.id);
  return { campaignId, memberId: member.id, inviteId: invite.id };
}

async function configureModel(workspaceId: string): Promise<void> {
  const port = (modelServer.address() as AddressInfo).port;
  await putWorkspaceAgentConfig(db, {
    workspaceId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'gpt-4o-mini'
  });
  await putWorkspaceSecret(db, { workspaceId, kind: 'model_api_key', plaintext: API_KEY });
  await setAgentBudget(db, workspaceId, { enabled: true, monthlyCapCents: 2000 });
}

beforeAll(async () => {
  vi.stubEnv('TREVRA_SECRETS_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('TREVRA_ALLOW_PRIVATE_MODEL_HOSTS', 'true');
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  modelServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      modelRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-ai-drafts-api',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [
            { index: 0, message: { role: 'assistant', content: DRAFT }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(FOREIGN);
  foreignToken = await legacySession(FOREIGN);
});

afterAll(async () => {
  for (const workspaceId of workspaces)
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await db?.close();
  await closeAuthDatabase();
  vi.unstubAllEnvs();
});

const foreign = (method: 'get' | 'post', path: string) =>
  request(app)[method](path).set('Cookie', `trevra_session=${foreignToken}`);

describe('AI draft API (TRV-039)', () => {
  it('drafts, lets a member edit, and keeps approve and reject owner-only', async () => {
    const owner = await signUp('ai-owner');
    workspaces.push(owner.workspaceId);
    const member = await signUp('ai-member');
    workspaces.push(member.workspaceId);
    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: owner.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: owner.workspaceId })
      .expect(200);
    await configureModel(owner.workspaceId);
    const fx = await campaignWithInvite(owner.workspaceId, `maya-api-${seq}`);
    const base = `/api/linkedin/manager/campaigns/${fx.campaignId}/ai-drafts`;

    const requested = await member.agent
      .post(base)
      .send({ targets: [{ memberId: fx.memberId, stepId: 'invite' }] })
      .expect(200);
    expect(requested.body.results[0]).toMatchObject({ outcome: 'drafted' });
    const draft = requested.body.drafts[0] as { id: string; payloadHash: string; text: string };
    expect(draft.text).toBe(DRAFT);
    expect(JSON.stringify(requested.body)).not.toContain(API_KEY);

    const deniedApprove = await member.agent
      .post(`${base}/${draft.id}/approve`)
      .send({ payloadHash: draft.payloadHash });
    expect(deniedApprove.status).toBe(403);
    const deniedReject = await member.agent.post(`${base}/${draft.id}/reject`).send({});
    expect(deniedReject.status).toBe(403);
    expect((await reviewLinkedInAction(db, owner.workspaceId, fx.inviteId))!.approved).toBe(false);

    const edited = await member.agent
      .post(`${base}/${draft.id}/edit`)
      .send({ text: `${DRAFT} Either way, congrats on the round.`, payloadHash: draft.payloadHash })
      .expect(200);
    const next = edited.body.draft as { id: string; payloadHash: string; origin: string };
    expect(next.origin).toBe('human_edit');
    expect(next.payloadHash).not.toBe(draft.payloadHash);

    // The pre-edit hash no longer approves anything.
    const stale = await owner.agent
      .post(`${base}/${next.id}/approve`)
      .send({ payloadHash: draft.payloadHash });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale');
    const malformed = await owner.agent
      .post(`${base}/${next.id}/approve`)
      .send({ payloadHash: 'not-a-hash' });
    expect(malformed.status).toBe(400);

    const approved = await owner.agent
      .post(`${base}/${next.id}/approve`)
      .send({ payloadHash: next.payloadHash })
      .expect(200);
    expect(approved.body.draft.status).toBe('approved');
    const review = (await reviewLinkedInAction(db, owner.workspaceId, fx.inviteId))!;
    expect(review).toMatchObject({ approved: true, contentHash: next.payloadHash });

    const listed = await member.agent.get(base).expect(200);
    expect(listed.body.readiness).toMatchObject({ modelConfigured: true, blocker: null });
    expect(listed.body.drafts.map((row: { status: string }) => row.status).sort()).toEqual([
      'approved',
      'edited'
    ]);

    // Another workspace cannot see, approve or reject any of it.
    expect((await foreign('get', base)).status).toBe(404);
    const crossApprove = await foreign('post', `${base}/${next.id}/approve`).send({
      payloadHash: next.payloadHash
    });
    expect(crossApprove.status).toBe(404);
    const crossReject = await foreign('post', `${base}/${next.id}/reject`).send({});
    expect(crossReject.status).toBe(404);
    const crossRequest = await foreign('post', base).send({
      targets: [{ memberId: fx.memberId }]
    });
    expect(crossRequest.status).toBe(404);
  });

  it('refuses 51 targets with a clear 400 and accepts exactly 50', async () => {
    const owner = await signUp('ai-batch');
    workspaces.push(owner.workspaceId);
    await configureModel(owner.workspaceId);
    const fx = await campaignWithInvite(owner.workspaceId, `maya-batch-${seq}`);
    const base = `/api/linkedin/manager/campaigns/${fx.campaignId}/ai-drafts`;
    const targets = (n: number) =>
      Array.from({ length: n }, (_, index) =>
        index === 0 ? { memberId: fx.memberId } : { memberId: `ghost_${index}` }
      );
    const before = modelRequests;
    const tooMany = await owner.agent.post(base).send({ targets: targets(51) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({ code: 'batch_too_large' });
    expect(tooMany.body.error).toBe(
      'At most 50 drafts can be requested at once; received 51. Split the batch.'
    );
    const empty = await owner.agent.post(base).send({ targets: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('batch_empty');
    expect(modelRequests).toBe(before);
    const ok = await owner.agent
      .post(base)
      .send({ targets: targets(50) })
      .expect(200);
    expect(ok.body.results).toHaveLength(50);
    expect(ok.body.drafts).toHaveLength(1);
    expect(modelRequests).toBe(before + 1);
  });

  it('refuses with a Setup link when no model is configured', async () => {
    const fx = await campaignWithInvite(FOREIGN, 'maya-nomodel');
    const base = `/api/linkedin/manager/campaigns/${fx.campaignId}/ai-drafts`;
    const refused = await foreign('post', base).send({ targets: [{ memberId: fx.memberId }] });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'model_not_configured', setupPath: '/setup' });
    expect(refused.body.error).toMatch(/Setup/);
    const listed = await foreign('get', base);
    expect(listed.status).toBe(200);
    expect(listed.body.readiness).toMatchObject({ modelConfigured: false, setupPath: '/setup' });
    expect(listed.body.drafts).toEqual([]);
  });
});
