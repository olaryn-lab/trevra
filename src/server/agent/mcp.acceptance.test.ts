import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import {
  AGENT_SCOPES,
  createAgentToken,
  revokeAgentToken,
  type AgentScope
} from '../agent-access.js';
import { createAgent, updateAgent } from '../agents.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { executePreparedPlaybookAction } from '../control-plane/execution.js';
import { openDatabase, type Db } from '../db.js';
import { registerPlaybook } from '../playbooks/registry.js';
import { ERROR_ENVELOPE_SCHEMA } from '../public-api/openapi.js';
import type { PublicApiRateLimitPolicy } from '../public-api/rate-limit.js';
import { PUBLIC_API_ROUTES } from '../public-api/registry.js';
import { listWorkspaceSkills } from '../skill-api.js';
import { toolNameForSkill } from './tools.js';

/**
 * TRV-054 acceptance: the MCP endpoint, end to end, against real PostgreSQL.
 *
 * Every request here is a raw JSON-RPC POST to /api/agent/mcp through the real
 * Express app (auth, TRV-053 limiter, route scope, MCP transport, tool layer),
 * so nothing below trusts a unit seam. The properties proven:
 *
 *   - the endpoint is token-authenticated and requires `skills:read`;
 *   - tools/list is exactly the documented built-ins plus assigned, enabled skills;
 *   - each tool is held to its own scope, the token's workspace, and the Agent's
 *     skill allow-list -- including skills reached through a playbook;
 *   - write-capable tools stop at the prepared-action / approval boundary and
 *     never reach an execution adapter;
 *   - tools/call is charged to the write bucket, once per call, batches included.
 */

// Wrapped, not replaced: the real adapter still runs if anything ever calls it,
// and the spy proves that nothing an agent can do over MCP does.
vi.mock('../control-plane/execution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../control-plane/execution.js')>();
  return {
    ...actual,
    executePreparedPlaybookAction: vi.fn(actual.executePreparedPlaybookAction)
  };
});

const SCORE_PLAYBOOK = 'test.mcp-acceptance-score';
registerPlaybook({
  id: SCORE_PLAYBOOK,
  version: '1.0.0',
  name: 'MCP acceptance score',
  description: 'One skill step, then a human approval.',
  inputSchema: z.object({ lead: z.record(z.unknown()) }),
  steps: [
    {
      id: 'score',
      type: 'skill',
      skillId: 'gtm.score-lead',
      input: { lead: { $ref: '$.input.lead' } }
    },
    {
      id: 'approve',
      type: 'approval',
      title: 'Approve score',
      needs: ['score'],
      payload: { score: { $ref: '$.steps.score.output.overall' } }
    }
  ],
  output: { approved: { $ref: '$.steps.approve.output.approved' } },
  source: { type: 'builtin' }
});

const MCP_PATH = '/api/agent/mcp';
const ACCEPT = 'application/json, text/event-stream';
const SCORE_SKILL = 'gtm.score-lead';
const SCORE_TOOL = 'trevra_gtm_score-lead';
const LEAD = { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } };
const EXTERNAL_WRITE_SKILL = 'gtm.share-update';
const EXTERNAL_WRITE_TOOL = 'trevra_gtm_share-update';
const HASH = /^[0-9a-f]{64}$/;
const SUFFIX = randomBytes(4).toString('hex');

/**
 * The documented built-in surface, written out independently of tools.ts so a
 * tool that appears or disappears there fails here too. Same list as
 * EXPECTED_BUILT_INS in tools.test.ts.
 */
const DOCUMENTED_BUILT_INS = [
  'trevra_list_skills',
  'trevra_list_people',
  'trevra_list_accounts',
  'trevra_list_opportunities',
  'trevra_list_conversations',
  'trevra_list_deliveries',
  'trevra_list_playbooks',
  'trevra_start_playbook',
  'trevra_list_playbook_runs',
  'trevra_get_playbook_run',
  'trevra_list_events',
  'trevra_list_runs',
  'trevra_get_run'
];

const LIMITS: PublicApiRateLimitPolicy = {
  windowMs: 60_000,
  read: { token: 4, workspace: 50 },
  write: { token: 2, workspace: 50 }
};

let db: Db;
let app: ReturnType<typeof createApp>;
let limited: ReturnType<typeof createApp>;
let clock = new Date('2026-10-31T16:00:10.000Z');
const created: string[] = [];
let agentCounter = 0;

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  limited = createApp(db, { publicApi: { rateLimits: LIMITS, now: () => clock } });
});

afterAll(async () => {
  if (db) {
    for (const workspaceId of created)
      await db.prepare('DELETE FROM public_api_rate_windows WHERE workspace_id=?').run(workspaceId);
    await db.close();
  }
  await closeAuthDatabase();
});

type App = ReturnType<typeof createApp>;

async function workspace(label: string) {
  const workspaceId = `ws_mcp_${label}_${SUFFIX}`;
  const userId = `usr_mcp_${label}_${SUFFIX}`;
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)')
    .run(workspaceId, `MCP ${label}`, now);
  await db
    .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES(?,?,?,?,?)')
    .run(userId, workspaceId, `${label}.${SUFFIX}@mcp-acceptance.test`, label, now);
  const session = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(
      createHash('sha256').update(session).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  created.push(workspaceId);
  return {
    workspaceId,
    userId,
    cookie: `trevra_session=${session}`,
    async token(scopes?: AgentScope[], agentId?: string) {
      const { token, record } = await createAgentToken(db, {
        workspaceId,
        userId,
        agentId,
        name: `${label} token`,
        scopes
      });
      return { authorization: `Bearer ${token}`, tokenId: record.id, agentId: record.agentId };
    },
    async agent(skillIds?: string[]) {
      agentCounter += 1;
      return createAgent(db, {
        workspaceId,
        createdByUserId: userId,
        name: `${label} agent ${agentCounter}`,
        purpose: 'MCP acceptance',
        skillIds
      });
    }
  };
}

interface McpReply {
  status: number;
  headers: Record<string, string>;
  /** The JSON body for non-stream answers (the public error envelope, 405s). */
  body: unknown;
  /** Every JSON-RPC message in an event-stream answer, in order. */
  messages: Array<Record<string, any>>;
}

async function mcp(
  target: App,
  authorization: string | null,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<McpReply> {
  let call = request(target).post(MCP_PATH).set('Accept', ACCEPT);
  if (authorization) call = call.set('Authorization', authorization);
  for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
  const res = await call
    .send(body as object)
    .buffer(true)
    .parse((stream, done) => {
      let text = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (text += chunk));
      stream.on('end', () => done(null, text));
    });
  const raw = typeof res.body === 'string' ? res.body : '';
  const isStream = String(res.headers['content-type'] ?? '').startsWith('text/event-stream');
  return {
    status: res.status,
    headers: res.headers as Record<string, string>,
    body: isStream || !raw ? null : JSON.parse(raw),
    messages: isStream
      ? raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)) as Record<string, any>)
      : []
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}, id: number = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

async function callTool(
  target: App,
  authorization: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ reply: McpReply; isError: boolean; value: any }> {
  const reply = await mcp(target, authorization, toolCall(name, args));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return { reply, ...toolOutcome(reply.messages[0]) };
}

function toolOutcome(message: Record<string, any> | undefined): { isError: boolean; value: any } {
  const result = message?.result;
  expect(result, JSON.stringify(message)).toBeDefined();
  const text = result.content?.[0]?.text as string | undefined;
  return { isError: result.isError === true, value: text ? JSON.parse(text) : undefined };
}

async function listTools(target: App, authorization: string) {
  const reply = await mcp(target, authorization, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(reply.status).toBe(200);
  return reply.messages[0]!.result.tools as Array<{
    name: string;
    inputSchema: { type: string };
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  }>;
}

async function count(
  table: 'skill_runs' | 'playbook_runs' | 'domain_events' | 'audit_events' | 'playbook_approvals',
  workspaceId: string,
  where = '',
  ...params: unknown[]
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS total FROM ${table} WHERE workspace_id=? ${where}`)
    .get<{ total: number }>(workspaceId, ...params);
  return row?.total ?? 0;
}

/** Every ledger a tool call could write to, for "nothing happened" assertions. */
async function ledger(workspaceId: string) {
  return {
    skillRuns: await count('skill_runs', workspaceId),
    playbookRuns: await count('playbook_runs', workspaceId),
    domainEvents: await count('domain_events', workspaceId),
    skillAudit: await count('audit_events', workspaceId, "AND event_type='skill.run'"),
    approvals: await count('playbook_approvals', workspaceId)
  };
}

function expectEnvelope(body: unknown, code: string) {
  const parsed = ERROR_ENVELOPE_SCHEMA.parse(body);
  expect(parsed.error.code).toBe(code);
  return parsed.error;
}

async function enabledSkillTools(workspaceId: string): Promise<string[]> {
  return (await listWorkspaceSkills(db, workspaceId))
    .filter((skill) => skill.enabled)
    .map((skill) => toolNameForSkill(skill.id));
}

/** A community skill that writes to an external system (same fixture as tools.test.ts). */
async function installExternalWriteSkill(workspaceId: string): Promise<void> {
  const manifest = {
    id: EXTERNAL_WRITE_SKILL,
    version: '1.0.0',
    name: 'Share update',
    description: 'Posts a workspace update to a connected external channel.',
    runtime: 'remote',
    artifact: { ref: 'https://module.example/share-update', digest: `sha256:${'b'.repeat(64)}` },
    entrypoint: [],
    sideEffect: 'external-write',
    requiresApproval: true,
    permissions: { network: ['module.example'], secrets: [], filesystem: 'none' },
    resources: { timeoutSeconds: 5, memoryMb: 64, cpu: 0.25, maxOutputBytes: 10_000 },
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: { posted: { type: 'boolean' } },
      required: ['posted'],
      additionalProperties: false
    },
    source: {
      repository: 'https://example.com/test/share-update',
      commit: 'abcdef1',
      license: 'MIT'
    }
  };
  await db
    .prepare(
      `INSERT INTO module_packages (module_id, publisher_id, source_type, name, description, visibility, latest_version)
       VALUES (?, NULL, 'community', ?, ?, 'public', ?) ON CONFLICT (module_id) DO NOTHING`
    )
    .run(manifest.id, manifest.name, manifest.description, manifest.version);
  await db
    .prepare(
      `INSERT INTO module_releases (
        module_id, version, runtime, artifact_ref, artifact_digest, manifest_json, permissions_json,
        input_schema_json, output_schema_json, side_effect, requires_approval, signature_payload_hash, status
      ) VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,'external-write',TRUE,?, 'verified')
      ON CONFLICT (module_id, version) DO NOTHING`
    )
    .run(
      manifest.id,
      manifest.version,
      manifest.runtime,
      manifest.artifact.ref,
      manifest.artifact.digest,
      JSON.stringify(manifest),
      JSON.stringify(manifest.permissions),
      JSON.stringify(manifest.inputSchema),
      JSON.stringify(manifest.outputSchema),
      'a'.repeat(64)
    );
  await db
    .prepare(
      `INSERT INTO workspace_module_installations (workspace_id, module_id, version, enabled, config_json)
       VALUES (?,?,?,TRUE,'{}'::jsonb) ON CONFLICT (workspace_id, module_id) DO NOTHING`
    )
    .run(workspaceId, manifest.id, manifest.version);
}

describe('MCP authentication', () => {
  it('answers missing, malformed, revoked, expired and paused-Agent credentials with the 401 envelope', async () => {
    const tenant = await workspace('auth');
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const expectUnauthenticated = async (authorization: string | null) => {
      const reply = await mcp(app, authorization, list);
      expect(reply.status, String(authorization)).toBe(401);
      expect(reply.headers['www-authenticate']).toMatch(/^Bearer realm="trevra"/);
      expect(reply.messages).toEqual([]);
      expectEnvelope(reply.body, 'unauthenticated');
    };

    await expectUnauthenticated(null);
    await expectUnauthenticated('Bearer not-a-trevra-token');
    await expectUnauthenticated(`Basic ${Buffer.from('agent:secret').toString('base64')}`);
    await expectUnauthenticated(`Bearer trv_live_${'x'.repeat(43)}`);

    const revoked = await tenant.token();
    expect((await mcp(app, revoked.authorization, list)).status).toBe(200);
    expect(await revokeAgentToken(db, tenant.workspaceId, tenant.userId, revoked.tokenId)).toBe(
      true
    );
    await expectUnauthenticated(revoked.authorization);

    const expired = await tenant.token();
    expect((await mcp(app, expired.authorization, list)).status).toBe(200);
    await db
      .prepare('UPDATE agent_tokens SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), expired.tokenId);
    await expectUnauthenticated(expired.authorization);

    const pausable = await tenant.agent();
    const paused = await tenant.token(undefined, pausable.id);
    expect((await mcp(app, paused.authorization, list)).status).toBe(200);
    await updateAgent(db, {
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      agentId: pausable.id,
      status: 'paused'
    });
    await expectUnauthenticated(paused.authorization);

    // A refused credential runs nothing, even when it asks for a write.
    for (const authorization of [revoked, expired, paused].map((t) => t.authorization)) {
      const reply = await mcp(app, authorization, toolCall(SCORE_TOOL, LEAD));
      expect(reply.status).toBe(401);
    }
    expect(await count('skill_runs', tenant.workspaceId)).toBe(0);
  });

  it('does not accept a signed-in browser session in place of an Agent token', async () => {
    const tenant = await workspace('cookie');
    // The cookie is a live session: the one public route that accepts sessions takes it.
    await request(app).get('/api/v1/openapi.json').set('Cookie', tenant.cookie).expect(200);

    const reply = await mcp(app, null, toolCall(SCORE_TOOL, LEAD), { Cookie: tenant.cookie });
    expect(reply.status).toBe(401);
    expectEnvelope(reply.body, 'unauthenticated');
    expect(await count('skill_runs', tenant.workspaceId)).toBe(0);
  });

  it('requires skills:read for every MCP method, before any tool runs', async () => {
    const tenant = await workspace('endpoint_scope');
    const everythingElse = await tenant.token(
      AGENT_SCOPES.filter((scope) => scope !== 'skills:read')
    );
    for (const body of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'acceptance', version: '1.0.0' }
        }
      },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      toolCall(SCORE_TOOL, LEAD),
      toolCall('trevra_list_people')
    ]) {
      const reply = await mcp(app, everythingElse.authorization, body);
      expect(reply.status, body.method).toBe(403);
      expect(expectEnvelope(reply.body, 'insufficient_scope').message).toContain('skills:read');
    }
    expect(await ledger(tenant.workspaceId)).toMatchObject({ skillRuns: 0, skillAudit: 0 });

    const full = await tenant.token();
    await request(app).get(MCP_PATH).set('Authorization', full.authorization).expect(405);
    await request(app).delete(MCP_PATH).set('Authorization', full.authorization).expect(405);
  });
});

describe('MCP tools/list', () => {
  it('is exactly the documented built-ins plus one tool per enabled skill assigned to the Agent', async () => {
    const tenant = await workspace('list');
    const inherit = await tenant.token();
    const expectedSkills = await enabledSkillTools(tenant.workspaceId);
    expect(expectedSkills).toContain(SCORE_TOOL);

    const tools = await listTools(app, inherit.authorization);
    expect(tools.map((tool) => tool.name)).toEqual([...DOCUMENTED_BUILT_INS, ...expectedSkills]);
    for (const tool of tools) expect(tool.inputSchema.type, tool.name).toBe('object');
    // Only one built-in changes state, and it is not destructive: it parks at approval.
    expect(
      tools
        .filter(
          (tool) => DOCUMENTED_BUILT_INS.includes(tool.name) && !tool.annotations.readOnlyHint
        )
        .map((tool) => tool.name)
    ).toEqual(['trevra_start_playbook']);
    expect(tools.filter((tool) => /approve|decide|execute|send/i.test(tool.name))).toEqual([]);

    // An Agent with an empty allow-list sees the built-ins and nothing else.
    const none = await tenant.agent([]);
    const noneToken = await tenant.token(undefined, none.id);
    expect((await listTools(app, noneToken.authorization)).map((tool) => tool.name)).toEqual(
      DOCUMENTED_BUILT_INS
    );

    // An Agent assigned one skill sees exactly that one.
    const one = await tenant.agent([SCORE_SKILL]);
    const oneToken = await tenant.token(undefined, one.id);
    expect((await listTools(app, oneToken.authorization)).map((tool) => tool.name)).toEqual([
      ...DOCUMENTED_BUILT_INS,
      SCORE_TOOL
    ]);

    // A disabled skill disappears for everyone, assigned or not, and cannot be called.
    await db
      .prepare('UPDATE workspace_skills SET enabled=FALSE WHERE workspace_id=? AND skill_id=?')
      .run(tenant.workspaceId, SCORE_SKILL);
    expect((await listTools(app, inherit.authorization)).map((tool) => tool.name)).toEqual([
      ...DOCUMENTED_BUILT_INS,
      ...expectedSkills.filter((name) => name !== SCORE_TOOL)
    ]);
    expect((await listTools(app, oneToken.authorization)).map((tool) => tool.name)).toEqual(
      DOCUMENTED_BUILT_INS
    );
    const disabled = await callTool(app, oneToken.authorization, SCORE_TOOL, LEAD);
    expect(disabled.isError).toBe(true);
    expect(await count('skill_runs', tenant.workspaceId)).toBe(0);
  });

  it('offers every tool name the public documentation promises', async () => {
    const tenant = await workspace('docs');
    const listed = new Set(
      (await listTools(app, (await tenant.token()).authorization)).map((tool) => tool.name)
    );
    const promised = new Set<string>();
    for (const text of [
      readFileSync('docs/api/public-api.md', 'utf8'),
      readFileSync('docs/agent-operation.md', 'utf8'),
      ...PUBLIC_API_ROUTES.map((route) => route.description ?? '')
    ])
      for (const match of text.matchAll(/\btrevra_[a-z][a-z0-9_]*/g)) promised.add(match[0]);
    expect(promised.size).toBeGreaterThanOrEqual(5);
    expect([...promised].filter((name) => !listed.has(name))).toEqual([]);
  });
});

describe('MCP per-tool scope', () => {
  it('refuses a tool whose scope the token lacks and writes nothing', async () => {
    const tenant = await workspace('tool_scope');
    const readOnly = await tenant.token(['skills:read']);
    const before = await ledger(tenant.workspaceId);

    for (const [name, args, scope] of [
      ['trevra_list_people', {}, 'workspace:read'],
      ['trevra_list_runs', {}, 'runs:read'],
      ['trevra_list_playbook_runs', {}, 'workflows:read'],
      [SCORE_TOOL, LEAD, 'skills:run'],
      ['trevra_start_playbook', { playbookId: SCORE_PLAYBOOK, input: LEAD }, 'playbooks:run']
    ] as const) {
      const outcome = await callTool(app, readOnly.authorization, name, args);
      expect(outcome.isError, name).toBe(true);
      expect(outcome.value).toEqual({ error: `Agent token is missing scope: ${scope}` });
    }
    expect(await ledger(tenant.workspaceId)).toEqual(before);
    expect(before).toMatchObject({ skillRuns: 0, playbookRuns: 0 });

    // The one ungated tool still answers with nothing but skills:read.
    const skills = await callTool(app, readOnly.authorization, 'trevra_list_skills');
    expect(skills.isError).toBe(false);
    expect(skills.value.some((skill: { id: string }) => skill.id === SCORE_SKILL)).toBe(true);
  });
});

describe('MCP workspace isolation', () => {
  it('answers every read from the token’s own workspace only', async () => {
    const seed = async (label: string) => {
      const tenant = await workspace(label);
      const { authorization } = await tenant.token();
      const contactId = `contact_mcp_${label}_${SUFFIX}`;
      const now = new Date().toISOString();
      await db
        .prepare(
          'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(
          contactId,
          tenant.workspaceId,
          `${label} person`,
          `${label}.${SUFFIX}@people.test`,
          `${label}.${SUFFIX}@people.test`,
          now,
          now
        );
      const skill = await callTool(app, authorization, SCORE_TOOL, LEAD);
      expect(skill.isError).toBe(false);
      const playbook = await callTool(app, authorization, 'trevra_start_playbook', {
        playbookId: SCORE_PLAYBOOK,
        input: LEAD
      });
      expect(playbook.value.status).toBe('waiting_approval');
      return {
        tenant,
        authorization,
        contactId,
        skillRunId: skill.value.run.id as string,
        playbookRunId: playbook.value.id as string
      };
    };
    const a = await seed('iso_a');
    const b = await seed('iso_b');

    for (const [self, other] of [
      [a, b],
      [b, a]
    ] as const) {
      const people = await callTool(app, self.authorization, 'trevra_list_people');
      expect(people.value.map((person: { id: string }) => person.id)).toEqual([self.contactId]);

      const runs = await callTool(app, self.authorization, 'trevra_list_runs');
      const runIds = runs.value.map((run: { id: string }) => run.id);
      expect(runIds).toContain(self.skillRunId);
      expect(runIds).not.toContain(other.skillRunId);
      for (const run of runs.value) expect(run.workspaceId).toBe(self.tenant.workspaceId);

      const pbRuns = await callTool(app, self.authorization, 'trevra_list_playbook_runs');
      expect(pbRuns.value.map((run: { id: string }) => run.id)).toEqual([self.playbookRunId]);

      const events = await callTool(app, self.authorization, 'trevra_list_events', { limit: 500 });
      expect(events.value.length).toBeGreaterThan(0);
      for (const event of events.value) expect(event.workspaceId).toBe(self.tenant.workspaceId);

      const ownRun = await callTool(app, self.authorization, 'trevra_get_run', {
        runId: self.skillRunId
      });
      expect(ownRun.value.id).toBe(self.skillRunId);
      const crossRun = await callTool(app, self.authorization, 'trevra_get_run', {
        runId: other.skillRunId
      });
      expect(crossRun).toMatchObject({ isError: true, value: { error: 'Skill run not found' } });

      const crossPlaybook = await callTool(app, self.authorization, 'trevra_get_playbook_run', {
        runId: other.playbookRunId
      });
      expect(crossPlaybook).toMatchObject({
        isError: true,
        value: { error: 'Playbook run not found' }
      });
    }
  });
});

describe('MCP skill assignment', () => {
  it('refuses an unassigned skill tool without a run, and runs it once assigned', async () => {
    const tenant = await workspace('assign');
    const agent = await tenant.agent([]);
    const { authorization } = await tenant.token(undefined, agent.id);

    const refused = await callTool(app, authorization, SCORE_TOOL, LEAD);
    expect(refused.isError).toBe(true);
    expect(refused.value.error).toBe(`Skill is not available to this Agent: ${SCORE_TOOL}`);
    expect(await ledger(tenant.workspaceId)).toMatchObject({ skillRuns: 0, skillAudit: 0 });

    await updateAgent(db, {
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      agentId: agent.id,
      skillIds: [SCORE_SKILL]
    });
    const ran = await callTool(app, authorization, SCORE_TOOL, LEAD);
    expect(ran.isError).toBe(false);
    expect(ran.value.run).toMatchObject({ skillId: SCORE_SKILL, status: 'ok' });
    expect(await count('skill_runs', tenant.workspaceId)).toBe(1);
    // The actor on the ledger is the Agent principal, never the credential.
    const audit = await db
      .prepare(
        "SELECT actor_type,actor_id FROM audit_events WHERE workspace_id=? AND event_type='skill.run'"
      )
      .all<{ actor_type: string; actor_id: string }>(tenant.workspaceId);
    expect(audit).toEqual([{ actor_type: 'agent', actor_id: agent.id }]);
  });
});

describe('MCP write boundary', () => {
  it('refuses an external-write skill before anything is recorded', async () => {
    const tenant = await workspace('external_write');
    await installExternalWriteSkill(tenant.workspaceId);
    const { authorization } = await tenant.token();

    const offered = (await listTools(app, authorization)).find(
      (tool) => tool.name === EXTERNAL_WRITE_TOOL
    );
    expect(offered?.annotations.destructiveHint).toBe(true);

    const outcome = await callTool(app, authorization, EXTERNAL_WRITE_TOOL, { text: 'we shipped' });
    expect(outcome.isError).toBe(true);
    expect(outcome.value.error).toBe(
      `Skill ${EXTERNAL_WRITE_SKILL} changes an external system and must be executed through a prepared, approved Trevra action`
    );
    expect(await ledger(tenant.workspaceId)).toEqual({
      skillRuns: 0,
      playbookRuns: 0,
      domainEvents: 0,
      skillAudit: 0,
      approvals: 0
    });
  });

  it('refuses a prepared-only playbook without creating a run', async () => {
    const tenant = await workspace('prepared_only');
    const { authorization } = await tenant.token();
    const outcome = await callTool(app, authorization, 'trevra_start_playbook', {
      playbookId: 'gtm.email-outreach',
      input: { idempotencyKey: 'eo_mcp_acceptance_1', prepared: true }
    });
    expect(outcome).toMatchObject({
      isError: true,
      value: { error: 'Email outreach starts only from a prepared outreach plan.' }
    });
    expect(await count('playbook_runs', tenant.workspaceId)).toBe(0);
  });

  it('parks an external-write playbook at a hash-pinned approval that only a human can release', async () => {
    const tenant = await workspace('buffer');
    // A restricted Agent: a playbook with no skill steps needs no skill assignment.
    const agent = await tenant.agent([]);
    const { authorization } = await tenant.token(undefined, agent.id);
    vi.mocked(executePreparedPlaybookAction).mockClear();

    const started = await callTool(app, authorization, 'trevra_start_playbook', {
      playbookId: 'gtm.buffer-draft',
      input: {
        sourcePostId: 'post_mcp_acceptance',
        channelId: 'channel_linkedin',
        channelName: 'LinkedIn',
        text: 'Drafted by an agent over MCP'
      }
    });
    expect(started.isError).toBe(false);
    const run = started.value;
    expect(run).toMatchObject({
      workspaceId: tenant.workspaceId,
      playbookId: 'gtm.buffer-draft',
      status: 'waiting_approval',
      actorType: 'agent',
      actorId: agent.id,
      currentStepId: 'approve-buffer-draft'
    });
    const steps = new Map<string, any>(run.steps.map((step: any) => [step.stepId, step]));
    expect(steps.get('approve-buffer-draft')).toMatchObject({ status: 'waiting_approval' });
    expect(steps.get('approve-buffer-draft').approvalPayloadHash).toMatch(HASH);
    expect(steps.get('create-buffer-draft')).toMatchObject({ status: 'pending' });

    const executionEvents = async () =>
      count(
        'domain_events',
        tenant.workspaceId,
        "AND event_type IN ('action.execution_started','action.executed')"
      );
    expect(await executionEvents()).toBe(0);
    expect(
      await count('domain_events', tenant.workspaceId, "AND event_type='approval.requested'")
    ).toBe(1);
    expect(executePreparedPlaybookAction).not.toHaveBeenCalled();
    expect(await count('playbook_approvals', tenant.workspaceId)).toBe(0);

    // The decision route is a browser-session route: the agent token is not a session.
    const decision = await request(app)
      .post(`/api/playbook-runs/${encodeURIComponent(run.id)}/steps/approve-buffer-draft/decision`)
      .set('Authorization', authorization)
      .send({ decision: 'approve' });
    expect(decision.status).toBe(401);

    const after = await callTool(app, authorization, 'trevra_get_playbook_run', { runId: run.id });
    expect(after.value.status).toBe('waiting_approval');
    expect(executePreparedPlaybookAction).not.toHaveBeenCalled();
    expect(await executionEvents()).toBe(0);
    expect(await count('playbook_approvals', tenant.workspaceId)).toBe(0);
  });
});

describe('MCP playbooks and the Agent skill allow-list', () => {
  it('refuses a playbook whose skill steps the Agent is not assigned, on MCP and REST alike', async () => {
    const tenant = await workspace('pb_allow');
    const agent = await tenant.agent([]);
    const { authorization } = await tenant.token(undefined, agent.id);

    const mcpRefusal = await callTool(app, authorization, 'trevra_start_playbook', {
      playbookId: SCORE_PLAYBOOK,
      input: LEAD
    });
    expect(mcpRefusal.isError).toBe(true);
    expect(mcpRefusal.value.error).toContain(SCORE_SKILL);
    expect(mcpRefusal.value.error).toContain('not assigned to this Agent');

    const restRefusal = await request(app)
      .post(`/api/agent/playbooks/${SCORE_PLAYBOOK}/runs`)
      .set('Authorization', authorization)
      .send({ input: LEAD })
      .expect(403);
    expect(expectEnvelope(restRefusal.body, 'skill_not_assigned').message).toContain(SCORE_SKILL);

    expect(await ledger(tenant.workspaceId)).toMatchObject({
      skillRuns: 0,
      playbookRuns: 0,
      skillAudit: 0
    });

    await updateAgent(db, {
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      agentId: agent.id,
      skillIds: [SCORE_SKILL]
    });
    const mcpStart = await callTool(app, authorization, 'trevra_start_playbook', {
      playbookId: SCORE_PLAYBOOK,
      input: LEAD
    });
    expect(mcpStart.isError).toBe(false);
    expect(mcpStart.value.status).toBe('waiting_approval');
    const restStart = await request(app)
      .post(`/api/agent/playbooks/${SCORE_PLAYBOOK}/runs`)
      .set('Authorization', authorization)
      .send({ input: LEAD })
      .expect(201);
    expect(restStart.body.run.status).toBe('waiting_approval');
    expect(await count('playbook_runs', tenant.workspaceId)).toBe(2);
    expect(await count('skill_runs', tenant.workspaceId)).toBe(2);

    // A legacy Agent with no allow-list inherits every enabled skill, playbooks included.
    const inherit = await tenant.token();
    const legacy = await callTool(app, inherit.authorization, 'trevra_start_playbook', {
      playbookId: SCORE_PLAYBOOK,
      input: LEAD
    });
    expect(legacy.value.status).toBe('waiting_approval');
  });
});

describe('MCP rate limits (TRV-053)', () => {
  const buckets = async (workspaceId: string) =>
    db
      .prepare(
        `SELECT subject,request_class,hits FROM public_api_rate_windows
         WHERE workspace_id=? ORDER BY request_class,subject`
      )
      .all<{ subject: string; request_class: string; hits: number }>(workspaceId);

  it('charges tools/call to the write bucket and refuses limit + 1 before the tool runs', async () => {
    clock = new Date('2026-10-31T17:00:10.000Z');
    const tenant = await workspace('rate_write');
    const { authorization, tokenId } = await tenant.token();

    for (const remaining of ['1', '0']) {
      const ok = await callTool(limited, authorization, SCORE_TOOL, LEAD);
      expect(ok.isError).toBe(false);
      expect(ok.reply.headers['x-ratelimit-limit']).toBe('2');
      expect(ok.reply.headers['x-ratelimit-remaining']).toBe(remaining);
    }
    const refused = await mcp(limited, authorization, toolCall(SCORE_TOOL, LEAD));
    expect(refused.status).toBe(429);
    expect(refused.messages).toEqual([]);
    expectEnvelope(refused.body, 'rate_limited');
    expect(refused.headers['retry-after']).toBe('50');
    expect(refused.headers['x-ratelimit-limit']).toBe('2');
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    expect(refused.headers['x-ratelimit-reset']).toBe(
      String(Date.parse('2026-10-31T17:01:00.000Z') / 1000)
    );
    expect(await count('skill_runs', tenant.workspaceId)).toBe(2);

    // tools/list is a read: still served, and charged to the read bucket only.
    const list = await mcp(limited, authorization, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.headers['x-ratelimit-limit']).toBe('4');
    expect(list.headers['x-ratelimit-remaining']).toBe('3');
    expect(await buckets(tenant.workspaceId)).toEqual([
      { subject: `token:${tokenId}`, request_class: 'read', hits: 1 },
      { subject: 'workspace', request_class: 'read', hits: 1 },
      { subject: `token:${tokenId}`, request_class: 'write', hits: 3 },
      { subject: 'workspace', request_class: 'write', hits: 2 }
    ]);
  });

  it('charges a JSON-RPC batch once per tools/call, so batching cannot multiply the write budget', async () => {
    clock = new Date('2026-10-31T18:00:10.000Z');
    const tenant = await workspace('rate_batch');
    const first = await tenant.token();

    // Two calls in one request spend both writes of the window.
    const pair = await mcp(limited, first.authorization, [
      toolCall(SCORE_TOOL, LEAD, 1),
      toolCall(SCORE_TOOL, LEAD, 2)
    ]);
    expect(pair.status).toBe(200);
    expect(pair.messages.map((message) => message.id).sort()).toEqual([1, 2]);
    for (const message of pair.messages) expect(toolOutcome(message).isError).toBe(false);
    expect(pair.headers['x-ratelimit-remaining']).toBe('0');
    expect(await count('skill_runs', tenant.workspaceId)).toBe(2);
    const next = await mcp(limited, first.authorization, toolCall(SCORE_TOOL, LEAD));
    expect(next.status).toBe(429);

    // A batch larger than the budget is refused whole: none of its calls run.
    const second = await tenant.token();
    const triple = await mcp(limited, second.authorization, [
      toolCall(SCORE_TOOL, LEAD, 1),
      toolCall(SCORE_TOOL, LEAD, 2),
      toolCall(SCORE_TOOL, LEAD, 3)
    ]);
    expect(triple.status).toBe(429);
    expectEnvelope(triple.body, 'rate_limited');
    expect(await count('skill_runs', tenant.workspaceId)).toBe(2);

    // Only tools/call is a write: a batch of one call and reads costs one write.
    const third = await tenant.token();
    const mixed = await mcp(limited, third.authorization, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      toolCall(SCORE_TOOL, LEAD, 2),
      { jsonrpc: '2.0', id: 3, method: 'ping' }
    ]);
    expect(mixed.status).toBe(200);
    expect(mixed.messages).toHaveLength(3);
    expect(mixed.headers['x-ratelimit-remaining']).toBe('1');
    const rows = await buckets(tenant.workspaceId);
    expect(rows.find((row) => row.subject === `token:${third.tokenId}`)).toEqual({
      subject: `token:${third.tokenId}`,
      request_class: 'write',
      hits: 1
    });
    // The workspace pays the same per-call price: 2 (pair) + 1 (mixed). The
    // refusals were stopped by their own token and never reached it.
    expect(
      rows.find((row) => row.subject === 'workspace' && row.request_class === 'write')?.hits
    ).toBe(3);
  });
});
