import type { Request, Response } from 'express';
import { z } from 'zod/v3';
import type { AgentIdentity, AgentScope } from '../agent-access.js';
import { configuredAgentSkillIds, getAgent } from '../agents.js';
import { callAgentTool, listSkillsForAgent } from '../agent/tools.js';
import { listDomainEvents } from '../control-plane/events.js';
import type { Db } from '../db.js';
import { handleMcpHttpRequest, rejectMcpNonPost } from '../mcp-http.js';
import { OPPORTUNITY_STAGES } from '../opportunities.js';
import { getPlaybookRun, listPlaybookRuns, startPlaybookRun } from '../playbooks/engine.js';
import { listWorkspacePlaybooks } from '../playbooks/registry.js';
import {
  executeWorkspaceSkill,
  getWorkspaceSkillRun,
  listWorkspaceSkillRuns
} from '../skill-api.js';
import { PublicApiError, validationError } from './errors.js';
import { buildOpenApiDocument } from './openapi.js';
import type { PublicApiRequestClass } from './rate-limit.js';

/**
 * THE SUPPORTED PUBLIC API (TRV-053). One registry, three consumers:
 *
 *   - `mount.ts` mounts exactly these routes, each behind token auth, the
 *     shared rate limiter, scope check, input validation and the error envelope;
 *   - `openapi.ts` generates GET /api/v1/openapi.json from these entries;
 *   - `public-api.contract.test.ts` proves every entry is mounted and that real
 *     responses validate against the documented schemas.
 *
 * A route that is not in this list is INTERNAL: it may change or disappear
 * without notice, and an agent token cannot reach it (browser-session routes
 * answer a token with 401). Adding an entry here is a public commitment --
 * versioning rules are in docs/api/public-api.md.
 *
 * Nothing here widens what an agent token may do. Every entry is either one of
 * the agent routes that existed before this registry, or a REST read over a
 * built-in MCP tool the same scope already reaches (`callAgentTool`, the exact
 * path MCP uses, so the two transports cannot drift). No entry approves,
 * executes, or sends anything.
 *
 * The request/response schemas below are the public contract and are kept
 * separate from app.ts's internal schemas on purpose: an internal route may
 * change its shape without silently changing the public one.
 */

export const PUBLIC_API_VERSION = '1.0.0';

export type PublicApiMethod = 'get' | 'post' | 'delete';
export type PublicApiAuth = 'token' | 'token_or_session';
/** `jsonrpc_method`: write for MCP `tools/call`, read for every other JSON-RPC method. */
export type PublicApiRateLimitClass = PublicApiRequestClass | 'jsonrpc_method';

export interface PublicApiResponseSpec {
  description: string;
  schema: z.ZodTypeAny;
  /** Defaults to application/json. */
  contentTypes?: readonly string[];
}

export interface PublicApiResult {
  status: number;
  body: unknown;
}

export interface PublicApiContext<
  P = Record<string, string>,
  Q = Record<string, unknown>,
  B = unknown
> {
  db: Db;
  req: Request;
  res: Response;
  workspaceId: string;
  /** Null only for a browser session on a `token_or_session` route. */
  agent: AgentIdentity | null;
  params: P;
  query: Q;
  body: B;
}

export interface PublicApiRoute {
  operationId: string;
  method: PublicApiMethod;
  /** Express path syntax (`:id`). OpenAPI uses `{id}`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: PublicApiAuth;
  /** Agent-token scope required; null = any valid token. */
  scope: AgentScope | null;
  rateLimitClass: PublicApiRateLimitClass;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  /** Documented as required. REST POSTs treat a missing body as `{}`. */
  bodyRequired?: boolean;
  success: PublicApiResponseSpec & { status: number };
  /** Statuses this operation can answer with the error envelope (beyond 401/429/500, always documented). */
  errors: readonly number[];
  /** Non-envelope responses defined by a wire protocol (MCP). */
  protocolResponses?: Readonly<Record<number, PublicApiResponseSpec>>;
  /** Returns the JSON result, or nothing when the handler wrote the response itself. */
  handler(ctx: PublicApiContext): Promise<PublicApiResult | void>;
}

type RouteDefinition<
  P extends z.AnyZodObject,
  Q extends z.AnyZodObject,
  B extends z.ZodTypeAny
> = Omit<PublicApiRoute, 'auth' | 'params' | 'query' | 'body' | 'handler'> & {
  params?: P;
  query?: Q;
  body?: B;
  handler(
    ctx: PublicApiContext<z.output<P>, z.output<Q>, z.output<B>> & { agent: AgentIdentity }
  ): Promise<PublicApiResult | void>;
};

/** An agent-token route. The handler always receives the resolved Agent. */
function agentRoute<
  P extends z.AnyZodObject = z.AnyZodObject,
  Q extends z.AnyZodObject = z.AnyZodObject,
  B extends z.ZodTypeAny = z.ZodTypeAny
>(definition: RouteDefinition<P, Q, B>): PublicApiRoute {
  return {
    ...definition,
    auth: 'token',
    handler: (ctx) => {
      if (!ctx.agent)
        throw new Error(`Public API route ${definition.operationId} reached without an Agent`);
      return definition.handler(ctx as Parameters<typeof definition.handler>[0]);
    }
  };
}

/* ---------------------------------------------------------------------------
 * Schemas. Responses are `.passthrough()`: adding a field is not a breaking
 * change, so the documented objects allow additional properties.
 * ------------------------------------------------------------------------ */

const resourceId = z.string().min(1).max(200);
const idParams = z.object({ id: resourceId });
const limitQuery = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const optionalLimitQuery = z.coerce.number().int().min(1).max(500).optional();
const jsonObject = z.record(z.unknown());
const nullableString = z.string().nullable();
const responseObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

const skillSideEffect = z.enum(['none', 'network-read', 'external-write']);

const skillManifestSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    sideEffect: skillSideEffect,
    requiresApproval: z.boolean(),
    enabled: z.boolean(),
    inputSchema: jsonObject,
    outputSchema: jsonObject,
    runtime: z.enum(['builtin', 'oci', 'wasi', 'remote']),
    sourceType: z.enum(['builtin', 'community']),
    publisher: z
      .object({
        id: z.string(),
        slug: z.string(),
        verified: z.boolean(),
        keyFingerprint: z.string()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

const skillRunSchema = z
  .object({
    id: z.string(),
    skillId: z.string(),
    skillVersion: z.string(),
    workspaceId: z.string(),
    status: z.enum(['ok', 'error']),
    input: z.unknown(),
    output: z.unknown(),
    error: nullableString,
    evidence: z.array(
      z
        .object({ label: z.string(), detail: z.string(), sourceUrl: nullableString.optional() })
        .passthrough()
    ),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number()
  })
  .passthrough();

const playbookRunStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled'
]);

const playbookManifestSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    pinnedVersion: nullableString,
    inputSchema: jsonObject,
    definition: jsonObject,
    source: z.object({ type: z.string(), ref: nullableString }).passthrough(),
    config: jsonObject
  })
  .passthrough();

const playbookStepRunSchema = z
  .object({
    id: z.string(),
    stepId: z.string(),
    stepType: z.enum(['skill', 'approval', 'action']),
    skillId: nullableString,
    skillVersion: nullableString,
    skillRunId: nullableString,
    status: z.enum([
      'pending',
      'running',
      'waiting_approval',
      'completed',
      'failed',
      'skipped',
      'cancelled'
    ]),
    attempt: z.number().int(),
    input: z.unknown(),
    output: z.unknown(),
    evidence: z.array(z.unknown()),
    error: nullableString,
    policyDecision: z.unknown(),
    approvalPayloadHash: nullableString.describe(
      'SHA-256 of the exact payload a human approves. Set while the step waits for approval.'
    ),
    startedAt: nullableString,
    finishedAt: nullableString,
    updatedAt: z.string()
  })
  .passthrough();

const playbookRunSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    playbookId: z.string(),
    playbookVersion: z.string(),
    status: playbookRunStatus,
    actorType: z.string(),
    actorId: nullableString,
    input: z.unknown(),
    output: z.unknown(),
    error: nullableString,
    currentStepId: nullableString,
    correlationId: z.string(),
    createdAt: z.string(),
    startedAt: nullableString,
    finishedAt: nullableString,
    updatedAt: z.string(),
    steps: z.array(playbookStepRunSchema)
  })
  .passthrough();

const domainEventSchema = z
  .object({
    position: z.number().int(),
    id: z.string(),
    workspaceId: z.string(),
    streamType: z.string(),
    streamId: z.string(),
    streamVersion: z.number().int(),
    eventType: z.string(),
    actorType: z.string(),
    actorId: nullableString,
    causationId: nullableString,
    correlationId: nullableString,
    payload: jsonObject,
    metadata: jsonObject,
    occurredAt: z.string()
  })
  .passthrough();

const personSchema = z.object({ id: z.string() }).passthrough();
const rankedAccountSchema = z
  .object({
    account: z.object({ id: z.string() }).passthrough(),
    score: jsonObject.nullable(),
    signals: z.array(jsonObject)
  })
  .passthrough();
const opportunitySchema = z
  .object({ id: z.string(), title: z.string(), stage: z.enum(OPPORTUNITY_STAGES) })
  .passthrough();
const conversationSchema = z.object({ id: z.string(), personId: z.string() }).passthrough();
const deliverySchema = z
  .object({ id: z.string(), status: z.string(), recipient: z.string() })
  .passthrough();

const jsonRpcMessageSchema = z
  .object({ jsonrpc: z.literal('2.0') })
  .passthrough()
  .describe('A JSON-RPC 2.0 message as defined by MCP Streamable HTTP.');
const jsonRpcErrorSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    error: z.object({ code: z.number().int(), message: z.string() }).passthrough(),
    id: z.null()
  })
  .passthrough();

const openApiDocumentSchema = z
  .object({ openapi: z.literal('3.1.0'), info: jsonObject, paths: jsonObject })
  .passthrough();

/** Request schemas. */
const skillRunQuery = z.object({
  skillId: z.string().min(1).max(200).optional(),
  status: z.enum(['ok', 'error']).optional(),
  limit: limitQuery(200, 50)
});
const playbookStartBody = z.object({
  version: z.string().min(1).max(50).optional(),
  input: z.unknown().default({}).describe('Playbook input; must satisfy the playbook inputSchema.')
});
const playbookRunQuery = z.object({
  status: playbookRunStatus.optional(),
  limit: limitQuery(200, 50)
});
const eventQuery = z.object({
  streamType: z.string().min(1).max(100).optional(),
  streamId: z.string().min(1).max(200).optional(),
  correlationId: z.string().min(1).max(200).optional(),
  afterPosition: z.coerce.number().int().nonnegative().optional(),
  limit: limitQuery(500, 100)
});

/** A REST read over a built-in MCP tool: same function, same scope check. */
async function toolRead(
  ctx: PublicApiContext & { agent: AgentIdentity },
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const defined = Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  );
  return callAgentTool(
    { db: ctx.db, workspaceId: ctx.agent.workspaceId, actorId: ctx.agent.agentId },
    ctx.agent.scopes,
    tool,
    defined
  );
}

const PER_ITEM_DESCRIPTION =
  'Each item carries at least the fields shown; additional fields may be added in a minor version.';

export const PUBLIC_API_ROUTES: readonly PublicApiRoute[] = Object.freeze([
  agentRoute({
    operationId: 'listSkills',
    method: 'get',
    path: '/api/agent/skills',
    tag: 'Skills',
    summary: 'List the skills this Agent may run',
    scope: 'skills:read',
    rateLimitClass: 'read',
    success: {
      status: 200,
      description: 'Enabled skills assigned to the token’s Agent.',
      schema: responseObject({ skills: z.array(skillManifestSchema) })
    },
    errors: [403],
    handler: async (ctx) => ({
      status: 200,
      body: { skills: await listSkillsForAgent(ctx.db, ctx.agent.workspaceId, ctx.agent.agentId) }
    })
  }),
  agentRoute({
    operationId: 'runSkill',
    method: 'post',
    path: '/api/agent/skills/:id/run',
    tag: 'Skills',
    summary: 'Run a skill and record the run in the ledger',
    description:
      'Executes a pure-computation or network-read skill. Skills that change an external system are refused with 409: those go through a prepared action and human approval inside Trevra. Not idempotent: every accepted call records a new run.',
    scope: 'skills:run',
    rateLimitClass: 'write',
    params: idParams,
    body: jsonObject.describe(
      'Skill input; must satisfy the skill inputSchema from GET /api/agent/skills.'
    ),
    success: {
      status: 201,
      description:
        'The recorded run. `approvalRequired` means a human must approve before the output is used.',
      schema: responseObject({
        run: skillRunSchema,
        approvalRequired: z.boolean(),
        sideEffect: skillSideEffect
      })
    },
    errors: [400, 403, 404, 409, 413],
    handler: async (ctx) => {
      const skillId = ctx.params.id;
      const agent = await getAgent(ctx.db, ctx.agent.workspaceId, ctx.agent.agentId);
      const allowed = agent ? configuredAgentSkillIds(agent) : null;
      if (allowed !== null && !allowed.includes(skillId))
        throw new PublicApiError(
          403,
          'skill_not_assigned',
          `Skill is not assigned to this Agent: ${skillId}`
        );
      const result = await executeWorkspaceSkill(ctx.db, {
        workspaceId: ctx.agent.workspaceId,
        skillId,
        payload: ctx.body,
        actorType: 'agent',
        actorId: ctx.agent.agentId
      });
      return { status: 201, body: result };
    }
  }),
  agentRoute({
    operationId: 'listSkillRuns',
    method: 'get',
    path: '/api/agent/runs',
    tag: 'Skill runs',
    summary: 'List recent skill runs in this workspace',
    scope: 'runs:read',
    rateLimitClass: 'read',
    query: skillRunQuery,
    success: {
      status: 200,
      description: 'Newest first.',
      schema: responseObject({ runs: z.array(skillRunSchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { runs: await listWorkspaceSkillRuns(ctx.db, ctx.agent.workspaceId, ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'getSkillRun',
    method: 'get',
    path: '/api/agent/runs/:id',
    tag: 'Skill runs',
    summary: 'Read one skill run',
    scope: 'runs:read',
    rateLimitClass: 'read',
    params: idParams,
    success: {
      status: 200,
      description: 'The run.',
      schema: responseObject({ run: skillRunSchema })
    },
    errors: [400, 403, 404],
    handler: async (ctx) => {
      const run = await getWorkspaceSkillRun(ctx.db, ctx.agent.workspaceId, ctx.params.id);
      if (!run) throw new PublicApiError(404, 'not_found', 'Skill run not found');
      return { status: 200, body: { run } };
    }
  }),
  agentRoute({
    operationId: 'listPlaybooks',
    method: 'get',
    path: '/api/agent/playbooks',
    tag: 'Playbooks',
    summary: 'List playbooks available to this workspace',
    scope: 'playbooks:read',
    rateLimitClass: 'read',
    success: {
      status: 200,
      description: 'Every registered playbook version with its workspace enablement.',
      schema: responseObject({ playbooks: z.array(playbookManifestSchema) })
    },
    errors: [403],
    handler: async (ctx) => ({
      status: 200,
      body: { playbooks: await listWorkspacePlaybooks(ctx.db, ctx.agent.workspaceId) }
    })
  }),
  agentRoute({
    operationId: 'startPlaybookRun',
    method: 'post',
    path: '/api/agent/playbooks/:id/runs',
    tag: 'Playbooks',
    summary: 'Start a durable playbook run',
    description:
      'Starts a run that pauses at every approval step until a human decides inside Trevra. Agents cannot approve. Prepared-only playbooks are refused with 409. Not idempotent: every accepted call starts a new run.',
    scope: 'playbooks:run',
    rateLimitClass: 'write',
    params: idParams,
    body: playbookStartBody,
    success: {
      status: 201,
      description: 'The new run.',
      schema: responseObject({ run: playbookRunSchema })
    },
    errors: [400, 403, 404, 409, 413],
    handler: async (ctx) => {
      try {
        const run = await startPlaybookRun(ctx.db, {
          workspaceId: ctx.agent.workspaceId,
          playbookId: ctx.params.id,
          version: ctx.body.version,
          payload: ctx.body.input,
          actorType: 'agent',
          actorId: ctx.agent.agentId
        });
        return { status: 201, body: { run } };
      } catch (error) {
        // The playbook's own input schema rejects `body.input`; say so.
        if (error instanceof z.ZodError) throw validationError('body', error, ['input']);
        throw error;
      }
    }
  }),
  agentRoute({
    operationId: 'listPlaybookRuns',
    method: 'get',
    path: '/api/agent/playbook-runs',
    tag: 'Playbook runs',
    summary: 'List playbook runs, including those waiting for approval',
    scope: 'workflows:read',
    rateLimitClass: 'read',
    query: playbookRunQuery,
    success: {
      status: 200,
      description:
        'Newest first. Filter `status=waiting_approval` for runs paused on a human decision.',
      schema: responseObject({ runs: z.array(playbookRunSchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { runs: await listPlaybookRuns(ctx.db, ctx.agent.workspaceId, ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'getPlaybookRun',
    method: 'get',
    path: '/api/agent/playbook-runs/:id',
    tag: 'Playbook runs',
    summary: 'Read one playbook run and its approval status',
    scope: 'workflows:read',
    rateLimitClass: 'read',
    params: idParams,
    success: {
      status: 200,
      description:
        'The run with every step; a step in `waiting_approval` carries `approvalPayloadHash`.',
      schema: responseObject({ run: playbookRunSchema })
    },
    errors: [400, 403, 404],
    handler: async (ctx) => {
      const run = await getPlaybookRun(ctx.db, ctx.agent.workspaceId, ctx.params.id);
      if (!run) throw new PublicApiError(404, 'not_found', 'Playbook run not found');
      return { status: 200, body: { run } };
    }
  }),
  agentRoute({
    operationId: 'listEvents',
    method: 'get',
    path: '/api/agent/events',
    tag: 'Events',
    summary: 'Read the append-only domain event ledger',
    scope: 'workflows:read',
    rateLimitClass: 'read',
    query: eventQuery,
    success: {
      status: 200,
      description: 'Oldest first by `position`; page with `afterPosition`.',
      schema: responseObject({ events: z.array(domainEventSchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { events: await listDomainEvents(ctx.db, ctx.agent.workspaceId, ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'listPeople',
    method: 'get',
    path: '/api/agent/people',
    tag: 'Workspace',
    summary: 'List People (leads) in this workspace',
    description: `REST form of the MCP tool trevra_list_people. ${PER_ITEM_DESCRIPTION}`,
    scope: 'workspace:read',
    rateLimitClass: 'read',
    query: z.object({ limit: optionalLimitQuery }),
    success: {
      status: 200,
      description: 'Newest first (default 100).',
      schema: responseObject({ people: z.array(personSchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { people: await toolRead(ctx, 'trevra_list_people', ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'listAccounts',
    method: 'get',
    path: '/api/agent/accounts',
    tag: 'Workspace',
    summary: 'List ranked target Accounts',
    description: `REST form of the MCP tool trevra_list_accounts. ${PER_ITEM_DESCRIPTION}`,
    scope: 'workspace:read',
    rateLimitClass: 'read',
    query: z.object({
      tier: z.enum(['hot', 'warm', 'cold']).optional(),
      limit: optionalLimitQuery
    }),
    success: {
      status: 200,
      description: 'Highest score first (default 50), each with up to five recent signals.',
      schema: responseObject({ accounts: z.array(rankedAccountSchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { accounts: await toolRead(ctx, 'trevra_list_accounts', ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'listOpportunities',
    method: 'get',
    path: '/api/agent/opportunities',
    tag: 'Workspace',
    summary: 'List GTM opportunities',
    description: `REST form of the MCP tool trevra_list_opportunities. ${PER_ITEM_DESCRIPTION}`,
    scope: 'workspace:read',
    rateLimitClass: 'read',
    query: z.object({ stage: z.enum(OPPORTUNITY_STAGES).optional(), limit: optionalLimitQuery }),
    success: {
      status: 200,
      description: 'Default 100.',
      schema: responseObject({ opportunities: z.array(opportunitySchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { opportunities: await toolRead(ctx, 'trevra_list_opportunities', ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'listConversations',
    method: 'get',
    path: '/api/agent/conversations',
    tag: 'Workspace',
    summary: 'List Person-led conversations across email and LinkedIn',
    description: `REST form of the MCP tool trevra_list_conversations. ${PER_ITEM_DESCRIPTION}`,
    scope: 'workspace:read',
    rateLimitClass: 'read',
    query: z.object({ limit: optionalLimitQuery }),
    success: {
      status: 200,
      description: 'Most recent activity first (default 100).',
      schema: responseObject({ conversations: z.array(conversationSchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { conversations: await toolRead(ctx, 'trevra_list_conversations', ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'listDeliveries',
    method: 'get',
    path: '/api/agent/deliveries',
    tag: 'Workspace',
    summary: 'List durable email delivery outcomes',
    description: `REST form of the MCP tool trevra_list_deliveries. ${PER_ITEM_DESCRIPTION}`,
    scope: 'workspace:read',
    rateLimitClass: 'read',
    query: z.object({ limit: optionalLimitQuery }),
    success: {
      status: 200,
      description: 'Default 100. Includes sent, failed and uncertain outcomes.',
      schema: responseObject({ deliveries: z.array(deliverySchema) })
    },
    errors: [400, 403],
    handler: async (ctx) => ({
      status: 200,
      body: { deliveries: await toolRead(ctx, 'trevra_list_deliveries', ctx.query) }
    })
  }),
  agentRoute({
    operationId: 'mcp',
    method: 'post',
    path: '/api/agent/mcp',
    tag: 'MCP',
    summary: 'MCP Streamable HTTP endpoint (stateless)',
    description:
      'Model Context Protocol over Streamable HTTP. The JSON-RPC body and response follow the MCP specification; the error envelope applies only to authentication, scope, rate-limit and transport failures. Rate-limit class: write for `tools/call`, read for every other method.',
    scope: 'skills:read',
    rateLimitClass: 'jsonrpc_method',
    body: z.unknown().describe('A JSON-RPC 2.0 message or batch.'),
    bodyRequired: true,
    success: {
      status: 200,
      description: 'JSON-RPC response, as JSON or as a single-response event stream.',
      schema: jsonRpcMessageSchema,
      contentTypes: ['application/json', 'text/event-stream']
    },
    errors: [403, 413],
    handler: async (ctx) => {
      await handleMcpHttpRequest(ctx.db, ctx.agent, ctx.req, ctx.res);
    }
  }),
  agentRoute({
    operationId: 'mcpGetNotSupported',
    method: 'get',
    path: '/api/agent/mcp',
    tag: 'MCP',
    summary: 'Server-initiated MCP streams are not offered',
    scope: 'skills:read',
    rateLimitClass: 'read',
    success: {
      status: 405,
      description: 'Always 405 with a JSON-RPC error: this server is stateless. Use POST.',
      schema: jsonRpcErrorSchema
    },
    errors: [403],
    handler: async (ctx) => {
      rejectMcpNonPost(ctx.req, ctx.res);
    }
  }),
  agentRoute({
    operationId: 'mcpDeleteNotSupported',
    method: 'delete',
    path: '/api/agent/mcp',
    tag: 'MCP',
    summary: 'MCP session termination is not needed',
    scope: 'skills:read',
    rateLimitClass: 'read',
    success: {
      status: 405,
      description: 'Always 405 with a JSON-RPC error: there is no MCP session to end.',
      schema: jsonRpcErrorSchema
    },
    errors: [403],
    handler: async (ctx) => {
      rejectMcpNonPost(ctx.req, ctx.res);
    }
  }),
  {
    operationId: 'getOpenApiDocument',
    method: 'get',
    path: '/api/v1/openapi.json',
    tag: 'Meta',
    summary: 'This OpenAPI 3.1 document',
    description:
      'Requires a valid agent token (any scope) or a signed-in Trevra browser session. Not linked from any public discovery file.',
    auth: 'token_or_session',
    scope: null,
    rateLimitClass: 'read',
    success: { status: 200, description: 'The OpenAPI document.', schema: openApiDocumentSchema },
    errors: [],
    handler: async () => ({ status: 200, body: openApiDocument() })
  }
]);

let cachedDocument: Record<string, unknown> | null = null;

/** Built once per process: the registry is static. */
export function openApiDocument(): Record<string, unknown> {
  cachedDocument ??= buildOpenApiDocument(PUBLIC_API_ROUTES, PUBLIC_API_VERSION);
  return cachedDocument;
}
