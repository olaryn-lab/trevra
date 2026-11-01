/**
 * TRV-054 acceptance: an agent prepares, starts and reads a LinkedIn campaign
 * over the real MCP endpoint, and still cannot get a single LinkedIn write out
 * without a person approving its exact content. Real PostgreSQL, the real
 * Express app, the real runner and the real worker gate; only the browser is a
 * double.
 */
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SCOPES, createAgentToken, type AgentScope } from '../agent-access.js';
import { createAgent } from '../agents.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { linkedinActionPolicyGate } from '../linkedin/action-policy.js';
import type { LinkedInDriver, LinkedInPage } from '../linkedin/driver.js';
import { postgresLocalWorkerStore, runLinkedInLocalBatch } from '../linkedin/local-worker.js';
import { runManagedCampaigns } from '../linkedin/runner.js';
import { upsertSeat } from '../linkedin/seats.js';
import { prepareOutreach } from '../outreach/prepare.js';

const MCP_PATH = '/api/agent/mcp';
const ACCEPT = 'application/json, text/event-stream';
const SUFFIX = randomBytes(4).toString('hex');
const plusHours = (at: Date, hours: number) => new Date(at.getTime() + hours * 3_600_000);

let db: Db;
let app: ReturnType<typeof createApp>;
const created: string[] = [];

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterAll(async () => {
  if (db) {
    for (const workspaceId of created) {
      await db.prepare('DELETE FROM public_api_rate_windows WHERE workspace_id=?').run(workspaceId);
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
    await db.close();
  }
  await closeAuthDatabase();
});

/** A workspace whose founder signs in with Trevra's own session (owner of their home workspace). */
async function workspace(label: string) {
  const workspaceId = `ws_licamp_${label}_${SUFFIX}`;
  const userId = `usr_licamp_${label}_${SUFFIX}`;
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,now())')
    .run(workspaceId, `LinkedIn agent ${label}`);
  await db
    .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES(?,?,?,?,now())')
    .run(userId, workspaceId, `${label}.${SUFFIX}@licamp.test`, label);
  const session = randomBytes(24).toString('hex');
  await db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,now()+interval '1 day',now())"
    )
    .run(createHash('sha256').update(session).digest('hex'), userId);
  created.push(workspaceId);
  await upsertSeat(
    db,
    workspaceId,
    {
      label: 'Founder LinkedIn',
      timezone: 'UTC',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workStartMinute: 0,
      workEndMinute: 1440
    },
    new Date()
  );
  const cookie = `trevra_session=${session}`;
  return {
    workspaceId,
    userId,
    cookie,
    async token(scopes?: AgentScope[], options: { agentId?: string; userId?: string | null } = {}) {
      const { token, record } = await createAgentToken(db, {
        workspaceId,
        userId: options.userId === undefined ? userId : options.userId,
        agentId: options.agentId,
        name: `${label} token`,
        scopes
      });
      return { authorization: `Bearer ${token}`, agentId: record.agentId };
    }
  };
}

async function callTool(authorization: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(MCP_PATH)
    .set('Accept', ACCEPT)
    .set('Authorization', authorization)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    .buffer(true)
    .parse((stream, done) => {
      let text = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (text += chunk));
      stream.on('end', () => done(null, text));
    });
  expect(res.status, String(res.body)).toBe(200);
  const message = String(res.body)
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as { result: any })[0]!;
  const text = message.result.content?.[0]?.text as string | undefined;
  return { isError: message.result.isError === true, value: text ? JSON.parse(text) : undefined };
}

async function listToolNames(authorization: string): Promise<string[]> {
  const res = await request(app)
    .post(MCP_PATH)
    .set('Accept', ACCEPT)
    .set('Authorization', authorization)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    .buffer(true)
    .parse((stream, done) => {
      let text = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (text += chunk));
      stream.on('end', () => done(null, text));
    });
  const line = String(res.body)
    .split('\n')
    .find((candidate) => candidate.startsWith('data:'))!;
  return (JSON.parse(line.slice(5)).result.tools as Array<{ name: string }>).map((t) => t.name);
}

async function campaignCount(workspaceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM linkedin_campaigns WHERE workspace_id=?')
    .get<{ total: number }>(workspaceId);
  return row?.total ?? 0;
}

const INVITE_NOTE = 'Hi there, thanks for helping test Trevra. This invite was sent through it.';
const DM_BODY = 'Thanks for connecting. Could you reply "got it"? That checks the reply stop.';
const STEPS = [
  {
    id: 'invite',
    action: 'connection_request',
    delayBefore: { amount: 0, unit: 'hours' },
    config: { message: INVITE_NOTE }
  },
  {
    id: 'dm',
    action: 'message',
    delayBefore: { amount: 0, unit: 'hours' },
    config: {
      requiresAcceptedConnection: true,
      variants: [{ id: 'a', body: DM_BODY, weight: 100 }]
    }
  },
  { id: 'done', action: 'end', config: { outcome: 'completed' } }
];

function prepareArgs(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `agent-test-${SUFFIX}`,
    name: 'Agent test campaign',
    seatKey: 'owner',
    people: [
      {
        profileUrl: `https://www.linkedin.com/in/agent-test-${SUFFIX}/`,
        firstName: 'Ada',
        lastName: 'Tester "QA"',
        company: 'Acme, Inc.'
      }
    ],
    steps: STEPS,
    ...overrides
  };
}

describe('agent LinkedIn campaign tools', () => {
  it('keep preparation behind the opt-in scope and create nothing without it', async () => {
    const tenant = await workspace('scope');
    const plain = await tenant.token();
    const listed = await listToolNames(plain.authorization);
    expect(listed).toContain('trevra_list_linkedin_seats');
    expect(listed).toContain('trevra_get_linkedin_campaign');
    expect(listed).not.toContain('trevra_prepare_linkedin_campaign');
    expect(listed).not.toContain('trevra_start_linkedin_campaign');
    for (const name of ['trevra_prepare_linkedin_campaign', 'trevra_start_linkedin_campaign']) {
      const outcome = await callTool(plain.authorization, name, prepareArgs());
      expect(outcome.isError, name).toBe(true);
      expect(outcome.value.error).toBe('Agent token is missing scope: outreach:prepare');
    }
    expect(await campaignCount(tenant.workspaceId)).toBe(0);

    // A token with nobody behind it cannot act for anybody.
    const orphan = await tenant.token([...AGENT_SCOPES], { userId: null });
    const refused = await callTool(
      orphan.authorization,
      'trevra_prepare_linkedin_campaign',
      prepareArgs()
    );
    expect(refused.isError).toBe(true);
    expect(refused.value.error).toMatch(/no person behind it/);
    expect(await campaignCount(tenant.workspaceId)).toBe(0);
  });

  it('refuse sequences and audiences outside the agent boundary', async () => {
    const tenant = await workspace('bounds');
    const { authorization } = await tenant.token([...AGENT_SCOPES]);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        {
          steps: [
            {
              id: 'mail',
              action: 'email',
              config: { subject: 'x', variants: [{ id: 'a', body: 'x', weight: 100 }] }
            }
          ]
        },
        /Step 1 \(email\) is not available to an agent/
      ],
      [
        {
          steps: [
            {
              id: 'dm',
              action: 'message',
              config: {
                variants: [
                  { id: 'a', body: 'x', weight: 100, attachmentUrl: 'https://example.test/a.pdf' }
                ]
              }
            }
          ]
        },
        /attachment/
      ],
      [
        {
          steps: [
            {
              id: 'c',
              action: 'condition',
              config: { condition: { kind: 'email_opened' }, yesStepId: 'c', noStepId: 'c' }
            }
          ]
        },
        /may check only/
      ],
      [
        {
          people: Array.from({ length: 101 }, (_, index) => ({
            profileUrl: `https://www.linkedin.com/in/p${index}-${SUFFIX}/`,
            firstName: 'P',
            lastName: String(index),
            company: 'Acme'
          }))
        },
        /At most 100 people/
      ],
      [
        {
          people: [{ profileUrl: 'guido', firstName: 'G', lastName: 'N', company: 'Acme' }]
        },
        /people\[0\]\.profileUrl: Not a LinkedIn profile URL/
      ],
      [
        {
          people: [
            {
              profileUrl: `https://www.linkedin.com/in/dup-${SUFFIX}/`,
              firstName: 'A',
              lastName: 'B',
              company: 'Acme'
            },
            {
              profileUrl: `https://linkedin.com/in/dup-${SUFFIX}`,
              firstName: 'A',
              lastName: 'B',
              company: 'Acme'
            }
          ]
        },
        /repeats an earlier person/
      ],
      [
        {
          people: [
            {
              profileUrl: `https://www.linkedin.com/in/nl-${SUFFIX}/`,
              firstName: 'A\nB',
              lastName: 'B',
              company: 'Acme'
            }
          ]
        },
        /single line/
      ],
      [
        {
          steps: [
            STEPS[0],
            { id: 'w', action: 'withdraw_pending', config: { afterDays: 14 } },
            STEPS[2]
          ]
        },
        /Step 2 \(withdraw_pending\) is not available to an agent/
      ],
      [{ seatKey: 'nobody' }, /was not found/]
    ];
    for (const [overrides, message] of cases) {
      const outcome = await callTool(
        authorization,
        'trevra_prepare_linkedin_campaign',
        prepareArgs(overrides)
      );
      expect(outcome.isError, JSON.stringify(overrides).slice(0, 80)).toBe(true);
      expect(outcome.value.error).toMatch(message);
    }
    expect(await campaignCount(tenant.workspaceId)).toBe(0);
  });

  it('prepare, start and read a campaign whose every write still waits for a person', async () => {
    const tenant = await workspace('flow');
    const { authorization, agentId } = await tenant.token([...AGENT_SCOPES]);
    // A standing workspace approval of LinkedIn writes. It must not reach an
    // agent-prepared campaign.
    await db
      .prepare(
        `INSERT INTO workspace_policies
         (id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at)
         VALUES (?,?,'allow linkedin',10,'action:linkedin.*','allow','{}'::jsonb,TRUE,now(),now())`
      )
      .run(`pol_licamp_${SUFFIX}`, tenant.workspaceId);

    const seats = await callTool(authorization, 'trevra_list_linkedin_seats');
    expect(seats.isError).toBe(false);
    expect(seats.value.seats).toEqual([
      expect.objectContaining({
        seatKey: 'owner',
        label: 'Founder LinkedIn',
        sendMode: 'automated'
      })
    ]);
    expect(seats.value.companionReady).toBe(false);
    expect(JSON.stringify(seats.value)).not.toMatch(/proxy/i);

    const prepared = await callTool(
      authorization,
      'trevra_prepare_linkedin_campaign',
      prepareArgs()
    );
    expect(prepared.isError, JSON.stringify(prepared.value)).toBe(false);
    expect(prepared.value).toMatchObject({
      status: 'prepared',
      duplicate: false,
      submittedPeople: 1,
      campaign: { status: 'draft', enrolled: 1, excluded: 0 }
    });
    const firstRead = await callTool(authorization, 'trevra_get_linkedin_campaign', {
      campaignId: prepared.value.campaign.id
    });
    // Quotes and commas survive the CSV path intact.
    expect(
      await db
        .prepare(
          'SELECT company FROM linkedin_lead_contacts WHERE workspace_id=? AND profile_url=?'
        )
        .get(tenant.workspaceId, `https://www.linkedin.com/in/agent-test-${SUFFIX}/`)
    ).toEqual({ company: 'Acme, Inc.' });
    expect(firstRead.value.members).toEqual([
      expect.objectContaining({
        name: 'Ada Tester "QA"',
        profileUrl: `https://www.linkedin.com/in/agent-test-${SUFFIX}/`,
        status: 'pending',
        exclusionReason: null
      })
    ]);
    const campaignId = prepared.value.campaign.id as string;
    expect(prepared.value.next.href).toBe(`/outreach/campaign/${campaignId}`);
    const stored = await db
      .prepare(
        'SELECT prepared_by_agent_id,owner_user_id FROM linkedin_campaigns WHERE workspace_id=? AND id=?'
      )
      .get<{ prepared_by_agent_id: string; owner_user_id: string }>(tenant.workspaceId, campaignId);
    expect(stored).toEqual({ prepared_by_agent_id: agentId, owner_user_id: tenant.userId });

    // The same key and input is the same campaign; the same key with other input is refused.
    const again = await callTool(authorization, 'trevra_prepare_linkedin_campaign', prepareArgs());
    expect(again.value).toMatchObject({ duplicate: true, campaign: { id: campaignId } });
    const changed = await callTool(
      authorization,
      'trevra_prepare_linkedin_campaign',
      prepareArgs({ name: 'Something else' })
    );
    expect(changed.isError).toBe(true);
    expect(changed.value.error).toMatch(/already used/);
    expect(await campaignCount(tenant.workspaceId)).toBe(1);
    const createdAudit = await db
      .prepare(
        `SELECT actor_type,actor_id FROM audit_events WHERE workspace_id=? AND entity_id=?
           AND event_type='linkedin_campaign.created'`
      )
      .all<{ actor_type: string; actor_id: string }>(tenant.workspaceId, campaignId);
    expect(createdAudit).toEqual([{ actor_type: 'agent', actor_id: agentId }]);

    // A person's draft, and another agent's, are not this agent's to start.
    const human = await prepareOutreach(db, {
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      idempotencyKey: `human-test-${SUFFIX}`,
      name: 'Founder draft',
      senderKey: 'owner',
      uploadedPeopleCsv: `first_name,last_name,company,linkedin\r\nHu,Man,Beta,https://www.linkedin.com/in/human-test-${SUFFIX}/`
    });
    const humanStart = await callTool(authorization, 'trevra_start_linkedin_campaign', {
      campaignId: human.campaign.id
    });
    expect(humanStart.isError).toBe(true);
    expect(humanStart.value.error).toBe('No campaign this agent prepared has that id.');
    const other = await createAgent(db, {
      workspaceId: tenant.workspaceId,
      createdByUserId: tenant.userId,
      name: `Other agent ${SUFFIX}`,
      purpose: 'acceptance'
    });
    const otherToken = await tenant.token([...AGENT_SCOPES], { agentId: other.id });
    const otherStart = await callTool(otherToken.authorization, 'trevra_start_linkedin_campaign', {
      campaignId
    });
    expect(otherStart.isError).toBe(true);
    const statusOf = async (id: string) =>
      (
        await db
          .prepare('SELECT status FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
          .get<{ status: string }>(tenant.workspaceId, id)
      )?.status;
    expect(await statusOf(human.campaign.id)).toBe('draft');
    expect(await statusOf(campaignId)).toBe('draft');

    const started = await callTool(authorization, 'trevra_start_linkedin_campaign', { campaignId });
    expect(started.isError, JSON.stringify(started.value)).toBe(false);
    expect(started.value).toMatchObject({ alreadyRunning: false, campaign: { status: 'running' } });
    const restarted = await callTool(authorization, 'trevra_start_linkedin_campaign', {
      campaignId
    });
    expect(restarted.value).toMatchObject({ alreadyRunning: true });
    expect(
      await db
        .prepare(
          `SELECT actor_type FROM audit_events WHERE workspace_id=? AND entity_id=?
             AND event_type='linkedin_campaign.started'`
        )
        .all(tenant.workspaceId, campaignId)
    ).toEqual([{ actor_type: 'agent' }]);

    const now = new Date();
    await runManagedCampaigns(db, tenant.workspaceId, plusHours(now, 2));
    const progress = await callTool(authorization, 'trevra_get_linkedin_campaign', { campaignId });
    expect(progress.isError, JSON.stringify(progress.value)).toBe(false);
    expect(progress.value.campaign).toMatchObject({ status: 'running', preparedByThisAgent: true });
    expect(progress.value.awaitingApproval).toEqual([
      expect.objectContaining({
        kind: 'invite',
        body: INVITE_NOTE,
        policy: 'Agent-prepared campaign rule'
      })
    ]);

    // The worker is refused until a person approves the exact content.
    const browserCalls: string[] = [];
    const worker = (when: Date) =>
      runLinkedInLocalBatch(postgresLocalWorkerStore(db, tenant.workspaceId, 'owner'), {
        driver: {
          sendInvite: async (_page: LinkedInPage, target: string) => {
            browserCalls.push(target);
            return {
              ok: true,
              externalRef: `agent-test-${browserCalls.length}`,
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
        authorizeAction: (action) => linkedinActionPolicyGate(db, tenant.workspaceId, action.id)
      });
    expect((await worker(plusHours(now, 3))).executed).toBe(0);
    expect(browserCalls).toEqual([]);

    // No agent tool approves; the founder does, in Trevra, by exact hash.
    const reviews = (
      await request(app)
        .get('/api/linkedin/manager/action-approvals')
        .set('Cookie', tenant.cookie)
        .expect(200)
    ).body.reviews as Array<{ actionId: string; contentHash: string; campaignId: string }>;
    const review = reviews.find((candidate) => candidate.campaignId === campaignId)!;
    expect(review).toBeDefined();
    await request(app)
      .post(`/api/linkedin/manager/action-approvals/${review.actionId}`)
      .set('Cookie', tenant.cookie)
      .send({ contentHash: review.contentHash })
      .expect(200);
    expect((await worker(plusHours(now, 3))).executed).toBe(1);
    expect(browserCalls).toEqual([`https://www.linkedin.com/in/agent-test-${SUFFIX}/`]);

    const after = await callTool(authorization, 'trevra_get_linkedin_campaign', { campaignId });
    expect(after.value.awaitingApproval).toEqual([]);
    expect(after.value.actions).toEqual([
      expect.objectContaining({
        id: review.actionId,
        kind: 'invite',
        status: 'sent',
        recordedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      })
    ]);

    // Somebody paused it: an agent never resumes.
    await request(app)
      .post(`/api/linkedin/manager/campaigns/${campaignId}/pause`)
      .set('Cookie', tenant.cookie)
      .send({})
      .expect(200);
    const resume = await callTool(authorization, 'trevra_start_linkedin_campaign', { campaignId });
    expect(resume.isError).toBe(true);
    expect(resume.value.error).toMatch(/This campaign is paused/);
    expect(await statusOf(campaignId)).toBe('paused');
  });

  it('act only with the token creator’s current role and seats', async () => {
    const tenant = await workspace('roles');
    const at = new Date().toISOString();
    // A teammate who is a plain member, with a Better Auth account.
    const memberUser = `usr_licamp_member_${SUFFIX}`;
    const memberEmail = `member.${SUFFIX}@licamp.test`;
    await db
      .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES(?,?,?,?,now())')
      .run(memberUser, tenant.workspaceId, memberEmail, 'Member');
    await db
      .prepare(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
         VALUES (?,?,?,false,?,?)`
      )
      .run(`au_licamp_${SUFFIX}`, 'Member', memberEmail, at, at);
    await db
      .prepare(`INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)`)
      .run(tenant.workspaceId, tenant.workspaceId, tenant.workspaceId, at);
    await db
      .prepare(
        `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,'member',?)`
      )
      .run(`mem_licamp_${SUFFIX}`, tenant.workspaceId, `au_licamp_${SUFFIX}`, at);
    const memberToken = await tenant.token([...AGENT_SCOPES], { userId: memberUser });

    // The seat is not theirs, so their agent cannot use it either.
    const refused = await callTool(
      memberToken.authorization,
      'trevra_prepare_linkedin_campaign',
      prepareArgs({ idempotencyKey: `member-test-${SUFFIX}` })
    );
    expect(refused.isError).toBe(true);
    expect(refused.value.error).toMatch(/Only the owner of “Founder LinkedIn”/);

    // Removed from the workspace: the token keeps nothing.
    await db.prepare('DELETE FROM member WHERE id=?').run(`mem_licamp_${SUFFIX}`);
    await db
      .prepare('UPDATE users SET workspace_id=? WHERE id=?')
      .run(
        (await db
          .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,now()) RETURNING id')
          .get<{ id: string }>(`ws_licamp_elsewhere_${SUFFIX}`, 'Elsewhere'))!.id,
        memberUser
      );
    created.push(`ws_licamp_elsewhere_${SUFFIX}`);
    const gone = await callTool(
      memberToken.authorization,
      'trevra_prepare_linkedin_campaign',
      prepareArgs({ idempotencyKey: `member-test-${SUFFIX}` })
    );
    expect(gone.isError).toBe(true);
    expect(gone.value.error).toMatch(/no longer a member of this workspace/);
    expect(await campaignCount(tenant.workspaceId)).toBe(0);
    await db.prepare('DELETE FROM "user" WHERE id=?').run(`au_licamp_${SUFFIX}`);
    await db.prepare('DELETE FROM organization WHERE id=?').run(tenant.workspaceId);
  });
});
