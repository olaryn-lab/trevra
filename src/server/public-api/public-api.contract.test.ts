import { createHash, randomBytes } from 'node:crypto';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import request, { type Response as TestResponse } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { createAgentToken, type AgentScope } from '../agent-access.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { id, openDatabase, type Db } from '../db.js';
import { registerPlaybook } from '../playbooks/registry.js';
import { openApiPath } from './openapi.js';
import { PUBLIC_API_ROUTES, type PublicApiRoute } from './registry.js';

/**
 * The public API contract (TRV-053):
 *   1. every registry route is mounted on the real app with its method and path;
 *   2. for every route group, real happy-path AND error-path responses validate
 *      against the schemas in the SERVED /api/v1/openapi.json.
 */

registerPlaybook({
  id: 'test.public-api-contract',
  version: '1.0.0',
  name: 'Public API contract',
  description: 'Exercise documented playbook responses.',
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

const LEAD = { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } };
const SUFFIX = randomBytes(4).toString('hex');
const WORKSPACE = `ws_papi_contract_${SUFFIX}`;
const USER = `usr_papi_contract_${SUFFIX}`;

let db: Db;
let app: ReturnType<typeof createApp>;
let doc: Record<string, any>;
let fullToken = '';
let session = '';
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();
const exercised = new Set<string>();

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)')
    .run(WORKSPACE, 'Public API contract', now);
  await db
    .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES(?,?,?,?,?)')
    .run(USER, WORKSPACE, `contract.${SUFFIX}@public-api.test`, 'Contract', now);
  session = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(
      createHash('sha256').update(session).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      id('con'),
      WORKSPACE,
      'Contract Person',
      `p.${SUFFIX}@lead.test`,
      `p.${SUFFIX}@lead.test`,
      now,
      now
    );
  fullToken = await token();
  doc = (await request(app).get('/api/v1/openapi.json').set('Authorization', fullToken).expect(200))
    .body;
});

afterAll(async () => {
  if (db) {
    await db.prepare('DELETE FROM public_api_rate_windows WHERE workspace_id=?').run(WORKSPACE);
    await db.close();
  }
  await closeAuthDatabase();
});

async function token(scopes?: AgentScope[]): Promise<string> {
  const created = await createAgentToken(db, {
    workspaceId: WORKSPACE,
    userId: USER,
    name: 'contract',
    scopes
  });
  return `Bearer ${created.token}`;
}

function routeOf(operationId: string): PublicApiRoute {
  const route = PUBLIC_API_ROUTES.find((candidate) => candidate.operationId === operationId);
  if (!route) throw new Error(`No registry route ${operationId}`);
  return route;
}

function resolveRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveRefs);
  if (!node || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === 'string') {
    const target = record.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], doc);
    return resolveRefs(target);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveRefs(value)])
  );
}

/** Assert a real response is documented for its operation and matches the documented schema. */
function assertDocumented(
  operationId: string,
  response: TestResponse,
  body: unknown = response.body
) {
  const route = routeOf(operationId);
  const status = String(response.status);
  const documented = doc.paths[openApiPath(route.path)]?.[route.method]?.responses?.[status];
  expect(documented, `${operationId} documents ${status}`).toBeDefined();
  expect(response.headers['x-request-id'], `${operationId} ${status} X-Request-Id`).toBeTruthy();
  const key = `${operationId}:${status}`;
  let validate = validators.get(key);
  if (!validate) {
    const schema = resolveRefs(documented.content['application/json'].schema) as object;
    validate = ajv.compile(schema);
    validators.set(key, validate);
  }
  expect(validate(body), `${key} ${JSON.stringify(validate.errors)}`).toBe(true);
  exercised.add(`${route.tag}:${response.status < 400 ? 'ok' : 'error'}`);
}

function call(route: PublicApiRoute, path = route.path) {
  return request(app)[route.method](path);
}

describe('public API contract', () => {
  it('mounts every registry route with its documented method and path', async () => {
    const stack = (
      app.router as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
      }
    ).stack;
    for (const route of PUBLIC_API_ROUTES) {
      const mounted = stack.some(
        (layer) => layer.route?.path === route.path && layer.route.methods[route.method] === true
      );
      expect(mounted, `${route.method.toUpperCase()} ${route.path}`).toBe(true);
      expect(doc.paths[openApiPath(route.path)]?.[route.method]?.operationId).toBe(
        route.operationId
      );
      // Live probe: the route's own handler answers, not the session wall.
      const probe = await call(route, route.path.replace(/:([A-Za-z0-9_]+)/g, 'probe'));
      expect(probe.status, route.operationId).toBe(401);
      expect(probe.body.error?.code, route.operationId).toBe('unauthenticated');
      assertDocumented(route.operationId, probe);
    }
  });

  it('validates skills and skill-run responses', async () => {
    const skills = await call(routeOf('listSkills')).set('Authorization', fullToken).expect(200);
    assertDocumented('listSkills', skills);
    const run = await call(routeOf('runSkill'), '/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', fullToken)
      .send(LEAD)
      .expect(201);
    assertDocumented('runSkill', run);
    const unknown = await call(routeOf('runSkill'), '/api/agent/skills/not.a-skill/run')
      .set('Authorization', fullToken)
      .send({})
      .expect(404);
    assertDocumented('runSkill', unknown);

    const runs = await call(routeOf('listSkillRuns'), '/api/agent/runs?limit=5')
      .set('Authorization', fullToken)
      .expect(200);
    assertDocumented('listSkillRuns', runs);
    const one = await call(routeOf('getSkillRun'), `/api/agent/runs/${run.body.run.id}`)
      .set('Authorization', fullToken)
      .expect(200);
    assertDocumented('getSkillRun', one);
    const missing = await call(routeOf('getSkillRun'), '/api/agent/runs/run_missing')
      .set('Authorization', fullToken)
      .expect(404);
    assertDocumented('getSkillRun', missing);
  });

  it('validates playbook and playbook-run responses', async () => {
    const playbooks = await call(routeOf('listPlaybooks'))
      .set('Authorization', fullToken)
      .expect(200);
    assertDocumented('listPlaybooks', playbooks);
    const started = await call(
      routeOf('startPlaybookRun'),
      '/api/agent/playbooks/test.public-api-contract/runs'
    )
      .set('Authorization', fullToken)
      .send({ input: LEAD })
      .expect(201);
    assertDocumented('startPlaybookRun', started);
    const invalid = await call(
      routeOf('startPlaybookRun'),
      '/api/agent/playbooks/test.public-api-contract/runs'
    )
      .set('Authorization', fullToken)
      .send({ input: {} })
      .expect(400);
    assertDocumented('startPlaybookRun', invalid);
    const prepared = await call(
      routeOf('startPlaybookRun'),
      '/api/agent/playbooks/gtm.email-outreach/runs'
    )
      .set('Authorization', fullToken)
      .send({ input: {} })
      .expect(409);
    assertDocumented('startPlaybookRun', prepared);

    const waiting = await call(
      routeOf('listPlaybookRuns'),
      '/api/agent/playbook-runs?status=waiting_approval'
    )
      .set('Authorization', fullToken)
      .expect(200);
    assertDocumented('listPlaybookRuns', waiting);
    expect(waiting.body.runs.map((run: { id: string }) => run.id)).toContain(started.body.run.id);
    const one = await call(
      routeOf('getPlaybookRun'),
      `/api/agent/playbook-runs/${started.body.run.id}`
    )
      .set('Authorization', fullToken)
      .expect(200);
    assertDocumented('getPlaybookRun', one);
    expect(
      one.body.run.steps.find((step: { status: string }) => step.status === 'waiting_approval')
        .approvalPayloadHash
    ).toHaveLength(64);
    const missing = await call(routeOf('getPlaybookRun'), '/api/agent/playbook-runs/pbr_missing')
      .set('Authorization', fullToken)
      .expect(404);
    assertDocumented('getPlaybookRun', missing);
  });

  it('validates event responses', async () => {
    const events = await call(routeOf('listEvents'), '/api/agent/events?limit=20')
      .set('Authorization', fullToken)
      .expect(200);
    assertDocumented('listEvents', events);
    expect(events.body.events.length).toBeGreaterThan(0);
    const invalid = await call(routeOf('listEvents'), '/api/agent/events?limit=501')
      .set('Authorization', fullToken)
      .expect(400);
    assertDocumented('listEvents', invalid);
  });

  it('validates workspace read responses', async () => {
    for (const [operationId, key] of [
      ['listPeople', 'people'],
      ['listAccounts', 'accounts'],
      ['listOpportunities', 'opportunities'],
      ['listConversations', 'conversations'],
      ['listDeliveries', 'deliveries']
    ] as const) {
      const ok = await call(routeOf(operationId)).set('Authorization', fullToken).expect(200);
      assertDocumented(operationId, ok);
      expect(Array.isArray(ok.body[key])).toBe(true);
      const invalid = await call(routeOf(operationId), `${routeOf(operationId).path}?limit=0`)
        .set('Authorization', fullToken)
        .expect(400);
      assertDocumented(operationId, invalid);
    }
    const people = await call(routeOf('listPeople')).set('Authorization', fullToken).expect(200);
    expect(people.body.people).toHaveLength(1);
    const noScope = await call(routeOf('listPeople'))
      .set('Authorization', await token(['skills:read']))
      .expect(403);
    assertDocumented('listPeople', noScope);
  });

  it('validates MCP transport responses', async () => {
    const initialize = await call(routeOf('mcp'))
      .set('Authorization', fullToken)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'contract', version: '1.0.0' }
        }
      })
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => done(null, text));
      })
      .expect(200);
    const raw = String(initialize.body);
    const message = String(initialize.headers['content-type']).startsWith('text/event-stream')
      ? JSON.parse(
          raw
            .split('\n')
            .find((line) => line.startsWith('data:'))!
            .slice(5)
        )
      : JSON.parse(raw);
    assertDocumented('mcp', initialize, message);
    expect(message.result.serverInfo.name).toBe('trevra');

    const get = await call(routeOf('mcpGetNotSupported'))
      .set('Authorization', fullToken)
      .expect(405);
    assertDocumented('mcpGetNotSupported', get);
    const del = await call(routeOf('mcpDeleteNotSupported'))
      .set('Authorization', fullToken)
      .expect(405);
    assertDocumented('mcpDeleteNotSupported', del);
    const forbidden = await call(routeOf('mcp'))
      .set('Authorization', await token(['runs:read']))
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(403);
    assertDocumented('mcp', forbidden);
  });

  it('validates the OpenAPI document responses', async () => {
    const viaSession = await call(routeOf('getOpenApiDocument'))
      .set('Cookie', `trevra_session=${session}`)
      .expect(200);
    assertDocumented('getOpenApiDocument', viaSession);
    const anonymous = await call(routeOf('getOpenApiDocument')).expect(401);
    assertDocumented('getOpenApiDocument', anonymous);
  });

  it('exercised a happy path and an error path for every route group', () => {
    for (const tag of new Set(PUBLIC_API_ROUTES.map((route) => route.tag))) {
      expect(exercised.has(`${tag}:ok`), `${tag} happy path`).toBe(true);
      expect(exercised.has(`${tag}:error`), `${tag} error path`).toBe(true);
    }
  });
});
