import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { createAgentToken, type AgentScope } from '../agent-access.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { registerPlaybook } from '../playbooks/registry.js';
import { ERROR_ENVELOPE_SCHEMA } from './openapi.js';
import {
  consumePublicApiRateLimit,
  prunePublicApiRateWindows,
  type PublicApiRateLimitPolicy
} from './rate-limit.js';
import { PUBLIC_API_ROUTES } from './registry.js';

registerPlaybook({
  id: 'test.public-api-approval',
  version: '1.0.0',
  name: 'Public API approval',
  description: 'Exercise the public playbook routes.',
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
const LIMITS: PublicApiRateLimitPolicy = {
  windowMs: 60_000,
  read: { token: 3, workspace: 5 },
  write: { token: 2, workspace: 3 }
};
const SUFFIX = randomBytes(4).toString('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: Db;
let app: ReturnType<typeof createApp>;
let limited: ReturnType<typeof createApp>;
let clock = new Date('2026-10-31T12:00:10.000Z');
const created: string[] = [];

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

async function workspace(label: string) {
  const workspaceId = `ws_papi_${label}_${SUFFIX}`;
  const userId = `usr_papi_${label}_${SUFFIX}`;
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)')
    .run(workspaceId, `Public API ${label}`, now);
  await db
    .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES(?,?,?,?,?)')
    .run(userId, workspaceId, `${label}.${SUFFIX}@public-api.test`, label, now);
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
    cookie: `trevra_session=${session}`,
    token: async (scopes?: AgentScope[]) =>
      `Bearer ${(await createAgentToken(db, { workspaceId, userId, name: `${label} token`, scopes })).token}`
  };
}

function expectEnvelope(
  body: unknown,
  code: string
): z.infer<typeof ERROR_ENVELOPE_SCHEMA>['error'] {
  const parsed = ERROR_ENVELOPE_SCHEMA.parse(body);
  expect(parsed.error.code).toBe(code);
  return parsed.error;
}

describe('public API errors', () => {
  it('answers unauthenticated calls with the 401 envelope and echoes the request id', async () => {
    const missing = await request(app)
      .get('/api/agent/skills')
      .set('X-Request-Id', 'trv-test.req:1')
      .expect(401);
    expect(missing.headers['x-request-id']).toBe('trv-test.req:1');
    expect(missing.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(missing.headers['x-ratelimit-limit']).toBeUndefined();
    expect(expectEnvelope(missing.body, 'unauthenticated').requestId).toBe('trv-test.req:1');

    const forged = await request(app)
      .post('/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', `Bearer trv_live_${'x'.repeat(43)}`)
      .send(LEAD)
      .expect(401);
    expectEnvelope(forged.body, 'unauthenticated');

    // A forged session cookie skips the per-address bucket on the way in; the
    // 401 must still be charged to it.
    const cookieOnly = await request(app)
      .get('/api/agent/skills')
      .set('Cookie', 'trevra.session_token=forged')
      .expect(401);
    expectEnvelope(cookieOnly.body, 'unauthenticated');
    expect(cookieOnly.headers['ratelimit-limit']).toBe('300');

    // An unsafe caller id is replaced, never reflected.
    const unsafe = await request(app)
      .get('/api/agent/runs')
      .set('X-Request-Id', `${'a'.repeat(200)}`)
      .expect(401);
    expect(unsafe.headers['x-request-id']).toMatch(UUID);
    expect(expectEnvelope(unsafe.body, 'unauthenticated').requestId).toBe(
      unsafe.headers['x-request-id']
    );
  });

  it('keeps every read inside the token’s own workspace', async () => {
    const owner = await workspace('owner');
    const other = await workspace('other');
    const ownerToken = await owner.token();
    const otherToken = await other.token();

    const run = await request(app)
      .post('/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', ownerToken)
      .send(LEAD)
      .expect(201);
    const runId = run.body.run.id as string;
    await request(app).get(`/api/agent/runs/${runId}`).set('Authorization', ownerToken).expect(200);
    const crossRun = await request(app)
      .get(`/api/agent/runs/${runId}`)
      .set('Authorization', otherToken)
      .set('X-Request-Id', 'cross-tenant-1')
      .expect(404);
    expect(expectEnvelope(crossRun.body, 'not_found')).toEqual({
      code: 'not_found',
      message: 'Skill run not found',
      requestId: 'cross-tenant-1'
    });
    const otherRuns = await request(app)
      .get('/api/agent/runs')
      .set('Authorization', otherToken)
      .expect(200);
    expect(otherRuns.body.runs).toEqual([]);

    const playbook = await request(app)
      .post('/api/agent/playbooks/test.public-api-approval/runs')
      .set('Authorization', ownerToken)
      .send({ input: LEAD })
      .expect(201);
    expect(playbook.body.run.status).toBe('waiting_approval');
    const crossPlaybook = await request(app)
      .get(`/api/agent/playbook-runs/${playbook.body.run.id}`)
      .set('Authorization', otherToken)
      .expect(404);
    expectEnvelope(crossPlaybook.body, 'not_found');
  });

  it('returns 400 validation envelopes with field details', async () => {
    const tenant = await workspace('validation');
    const token = await tenant.token();

    const query = await request(app)
      .get('/api/agent/runs?limit=0&status=bogus')
      .set('Authorization', token)
      .expect(400);
    const queryError = expectEnvelope(query.body, 'validation_failed');
    expect(queryError.details?.map(({ location, field }) => `${location}:${field}`).sort()).toEqual(
      ['query:limit', 'query:status']
    );

    const body = await request(app)
      .post('/api/agent/playbooks/test.public-api-approval/runs')
      .set('Authorization', token)
      .send({ input: { lead: 'not-an-object' } })
      .expect(400);
    expect(expectEnvelope(body.body, 'validation_failed').details).toEqual([
      expect.objectContaining({ location: 'body', field: 'input.lead' })
    ]);

    const malformed = await request(app)
      .post('/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', token)
      .set('Content-Type', 'application/json')
      .send('{"lead":')
      .expect(400);
    expectEnvelope(malformed.body, 'invalid_json');
    expect(JSON.stringify(malformed.body)).not.toMatch(/stack|SyntaxError|at /);
  });

  it('refuses missing scopes, other methods and external writes in the envelope', async () => {
    const tenant = await workspace('scopes');
    const readOnly = await tenant.token(['skills:read']);
    const scope = await request(app)
      .get('/api/agent/runs')
      .set('Authorization', readOnly)
      .expect(403);
    expect(expectEnvelope(scope.body, 'insufficient_scope').message).toContain('runs:read');

    const method = await request(app)
      .put('/api/agent/skills')
      .set('Authorization', readOnly)
      .expect(405);
    expect(method.headers.allow).toBe('GET, HEAD');
    expectEnvelope(method.body, 'method_not_allowed');

    const full = await tenant.token();
    const prepared = await request(app)
      .post('/api/agent/playbooks/gtm.email-outreach/runs')
      .set('Authorization', full)
      .send({ input: {}, prepared: true })
      .expect(409);
    expectEnvelope(prepared.body, 'conflict');

    // Not a registry path: still the session wall, exactly as before.
    const internal = await request(app)
      .get('/api/dashboard')
      .set('Authorization', full)
      .expect(401);
    expect(internal.body).toEqual({ error: 'Session expired' });
  });
});

describe('public API rate limits', () => {
  const windowEnd = () => Math.floor(clock.getTime() / 60_000) * 60_000 + 60_000;

  it('answers 429 exactly at limit + 1 with headers, then resets with the window', async () => {
    clock = new Date('2026-10-31T12:00:10.000Z');
    const tenant = await workspace('window');
    const token = await tenant.token();
    for (const remaining of ['2', '1', '0']) {
      const ok = await request(limited)
        .get('/api/agent/skills')
        .set('Authorization', token)
        .expect(200);
      expect(ok.headers['x-ratelimit-limit']).toBe('3');
      expect(ok.headers['x-ratelimit-remaining']).toBe(remaining);
      expect(ok.headers['x-ratelimit-reset']).toBe(String(windowEnd() / 1000));
      expect(ok.headers['retry-after']).toBeUndefined();
    }
    const refused = await request(limited)
      .get('/api/agent/skills')
      .set('Authorization', token)
      .set('X-Request-Id', 'limit-plus-one')
      .expect(429);
    expect(refused.headers['x-ratelimit-limit']).toBe('3');
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    expect(refused.headers['x-ratelimit-reset']).toBe(String(windowEnd() / 1000));
    expect(refused.headers['retry-after']).toBe('50');
    expect(refused.headers['x-request-id']).toBe('limit-plus-one');
    expect(expectEnvelope(refused.body, 'rate_limited').requestId).toBe('limit-plus-one');

    clock = new Date('2026-10-31T12:00:59.999Z');
    const lastMoment = await request(limited)
      .get('/api/agent/skills')
      .set('Authorization', token)
      .expect(429);
    expect(lastMoment.headers['retry-after']).toBe('1');

    clock = new Date('2026-10-31T12:01:00.000Z');
    const reset = await request(limited)
      .get('/api/agent/skills')
      .set('Authorization', token)
      .expect(200);
    expect(reset.headers['x-ratelimit-remaining']).toBe('2');
    expect(reset.headers['x-ratelimit-reset']).toBe(String(windowEnd() / 1000));
  });

  it('shares a workspace bucket across tokens and keeps writes lower and separate', async () => {
    clock = new Date('2026-10-31T13:00:05.000Z');
    const tenant = await workspace('shared');
    const first = await tenant.token();
    const second = await tenant.token();
    for (let call = 0; call < 3; call += 1)
      await request(limited).get('/api/agent/runs').set('Authorization', first).expect(200);
    // Refused by its own bucket, and NOT charged to the workspace.
    const tokenRefusal = await request(limited)
      .get('/api/agent/runs')
      .set('Authorization', first)
      .expect(429);
    expect(tokenRefusal.headers['x-ratelimit-limit']).toBe('3');
    for (let call = 0; call < 2; call += 1)
      await request(limited).get('/api/agent/runs').set('Authorization', second).expect(200);
    const workspaceRefusal = await request(limited)
      .get('/api/agent/runs')
      .set('Authorization', second)
      .expect(429);
    expect(workspaceRefusal.headers['x-ratelimit-limit']).toBe('5');
    expect(expectEnvelope(workspaceRefusal.body, 'rate_limited').message).toContain('workspace');

    // Writes have their own, lower budget: reads are exhausted, writes are not.
    for (let call = 0; call < 2; call += 1) {
      const write = await request(limited)
        .post('/api/agent/skills/gtm.score-lead/run')
        .set('Authorization', first)
        .send(LEAD)
        .expect(201);
      expect(write.headers['x-ratelimit-limit']).toBe('2');
    }
    const writeRefusal = await request(limited)
      .post('/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', first)
      .send(LEAD)
      .expect(429);
    expect(writeRefusal.headers['x-ratelimit-limit']).toBe('2');
    const runs = await db
      .prepare('SELECT COUNT(*)::int AS total FROM skill_runs WHERE workspace_id=?')
      .get<{ total: number }>(tenant.workspaceId);
    expect(runs?.total).toBe(2);

    const buckets = await db
      .prepare(
        `SELECT subject,request_class,hits FROM public_api_rate_windows
         WHERE workspace_id=? ORDER BY request_class,subject`
      )
      .all<{ subject: string; request_class: string; hits: number }>(tenant.workspaceId);
    const workspaceRead = buckets.find(
      (row) => row.subject === 'workspace' && row.request_class === 'read'
    );
    expect(workspaceRead?.hits).toBe(6);
  });

  it('does not charge session-authenticated internal routes', async () => {
    clock = new Date('2026-10-31T14:00:00.000Z');
    const tenant = await workspace('session');
    const internal = await request(limited)
      .get('/api/agent-tokens')
      .set('Cookie', tenant.cookie)
      .expect(200);
    expect(internal.headers['x-ratelimit-limit']).toBeUndefined();
    const rows = await db
      .prepare('SELECT COUNT(*)::int AS total FROM public_api_rate_windows WHERE workspace_id=?')
      .get<{ total: number }>(tenant.workspaceId);
    expect(rows?.total).toBe(0);
  });

  it('counts atomically under concurrency and prunes closed windows', async () => {
    const tenant = await workspace('prune');
    const now = new Date('2026-10-31T15:30:30.000Z');
    const decisions = await Promise.all(
      Array.from({ length: 8 }, () =>
        consumePublicApiRateLimit(db, {
          workspaceId: tenant.workspaceId,
          tokenId: 'tok_concurrency',
          requestClass: 'read',
          now,
          policy: LIMITS
        })
      )
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(5);

    await consumePublicApiRateLimit(db, {
      workspaceId: tenant.workspaceId,
      tokenId: null,
      requestClass: 'write',
      now: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      policy: LIMITS
    });
    const removed = await prunePublicApiRateWindows(db, now);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await db
      .prepare(
        'SELECT request_class,window_start FROM public_api_rate_windows WHERE workspace_id=?'
      )
      .all<{ request_class: string }>(tenant.workspaceId);
    expect(left.map((row) => row.request_class)).toEqual(['read', 'read']);
  });
});

describe('GET /api/v1/openapi.json', () => {
  it('requires a token or a session', async () => {
    const anonymous = await request(app).get('/api/v1/openapi.json').expect(401);
    expect(expectEnvelope(anonymous.body, 'unauthenticated').message).toContain('session');
    const tenant = await workspace('docs');
    await request(app)
      .get('/api/v1/openapi.json')
      .set('Authorization', await tenant.token(['runs:read']))
      .expect(200);
    const viaSession = await request(app)
      .get('/api/v1/openapi.json')
      .set('Cookie', tenant.cookie)
      .expect(200);
    expect(viaSession.body.openapi).toBe('3.1.0');
  });

  it('is a structurally valid OpenAPI 3.1 document covering exactly the registry', async () => {
    const tenant = await workspace('structure');
    const { body: doc } = await request(app)
      .get('/api/v1/openapi.json')
      .set('Authorization', await tenant.token())
      .expect(200);

    expect(doc.openapi).toBe('3.1.0');
    expect(typeof doc.info.title).toBe('string');
    expect(typeof doc.info.version).toBe('string');
    expect(doc.components.securitySchemes.agentToken).toMatchObject({
      type: 'http',
      scheme: 'bearer'
    });

    const resolve = (pointer: string): unknown =>
      pointer
        .replace(/^#\//, '')
        .split('/')
        .reduce<unknown>(
          (node, key) =>
            (node as Record<string, unknown> | undefined)?.[
              key.replace(/~1/g, '/').replace(/~0/g, '~')
            ],
          doc
        );
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === 'string') {
        expect(record.$ref.startsWith('#/components/')).toBe(true);
        expect(resolve(record.$ref), record.$ref).toBeDefined();
      }
      Object.values(record).forEach(visit);
    };
    visit(doc);

    const declaredTags = new Set(doc.tags.map((tag: { name: string }) => tag.name));
    const schemes = new Set(Object.keys(doc.components.securitySchemes));
    const operationIds = new Set<string>();
    const documented: string[] = [];
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
      expect(path.startsWith('/')).toBe(true);
      const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      for (const [method, op] of Object.entries(item)) {
        expect(['get', 'post', 'put', 'patch', 'delete']).toContain(method);
        documented.push(`${method.toUpperCase()} ${path}`);
        expect(typeof op.operationId).toBe('string');
        expect(operationIds.has(op.operationId)).toBe(false);
        operationIds.add(op.operationId);
        expect(op.tags.every((tag: string) => declaredTags.has(tag))).toBe(true);
        for (const requirement of op.security)
          for (const name of Object.keys(requirement)) expect(schemes.has(name)).toBe(true);
        const pathParams = (op.parameters ?? [])
          .filter((parameter: { in: string }) => parameter.in === 'path')
          .map((parameter: { name: string; required: boolean }) => {
            expect(parameter.required).toBe(true);
            return parameter.name;
          })
          .sort();
        expect(pathParams).toEqual(templated);
        for (const parameter of op.parameters ?? []) {
          expect(['path', 'query', 'header', 'cookie']).toContain(parameter.in);
          expect(parameter.schema).toBeTypeOf('object');
        }
        const statuses = Object.keys(op.responses);
        expect(statuses.length).toBeGreaterThan(0);
        for (const status of statuses) {
          expect(status).toMatch(/^[1-5]\d\d$/);
          expect(typeof op.responses[status].description).toBe('string');
          expect(op.responses[status].headers['X-Request-Id']).toBeDefined();
        }
        expect(statuses).toEqual(expect.arrayContaining(['401', '429', '500']));
      }
    }
    expect(documented.sort()).toEqual(
      PUBLIC_API_ROUTES.map(
        (route) =>
          `${route.method.toUpperCase()} ${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`
      ).sort()
    );
  });

  it('is never linked from public discovery files', async () => {
    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/llms.txt',
      '/llms-full.txt',
      '/agents.md'
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(200);
      expect(response.text, path).not.toContain('openapi');
      expect(response.text, path).not.toContain('/api/v1/');
    }
  });
});
