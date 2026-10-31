import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod/v3';
import { DEFAULT_PUBLIC_API_RATE_LIMITS } from './rate-limit.js';
import type { PublicApiResponseSpec, PublicApiRoute } from './registry.js';

/**
 * OpenAPI 3.1 generated from `PUBLIC_API_ROUTES` and their Zod schemas. Nothing
 * here is hand-maintained per route: a registry entry IS its documentation.
 * Served at GET /api/v1/openapi.json to authenticated callers only, and never
 * linked from robots.txt, sitemap.xml, llms.txt or agents.md.
 */

export const ERROR_ENVELOPE_SCHEMA = z
  .object({
    error: z
      .object({
        code: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .describe('Stable snake_case identifier. Branch on this, not on `message`.'),
        message: z.string().describe('Human-readable explanation. May change between releases.'),
        requestId: z.string().describe('Same value as the X-Request-Id response header.'),
        details: z
          .array(
            z
              .object({
                location: z.enum(['path', 'query', 'body']),
                field: z.string(),
                code: z.string(),
                message: z.string()
              })
              .strict()
          )
          .optional()
          .describe('Present on 400 validation_failed: one entry per invalid field.')
      })
      .strict()
  })
  .strict();

const ALWAYS_DOCUMENTED_ERRORS = [401, 429, 500] as const;

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Invalid request: `validation_failed` (with `details`), `invalid_json`, or `invalid_request`.',
  401: '`unauthenticated`: missing, invalid, expired or revoked credential.',
  403: '`insufficient_scope`, `skill_not_assigned`, `origin_not_allowed`, or `forbidden`.',
  404: '`not_found`: the resource does not exist in the token’s workspace.',
  409: '`conflict`: the request is valid but refused in the current state.',
  413: '`payload_too_large`.',
  422: '`unprocessable_entity`.',
  429: '`rate_limited`: wait `Retry-After` seconds.',
  500: '`internal_error`: no internal detail is returned; quote `requestId` to support.'
};

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none'
  }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

export function openApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

const ref = (pointer: string) => ({ $ref: pointer });
const REQUEST_ID_HEADER = { 'X-Request-Id': ref('#/components/headers/X-Request-Id') };
const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': ref('#/components/headers/X-RateLimit-Limit'),
  'X-RateLimit-Remaining': ref('#/components/headers/X-RateLimit-Remaining'),
  'X-RateLimit-Reset': ref('#/components/headers/X-RateLimit-Reset')
};

function headersFor(status: number): Record<string, unknown> {
  if (status === 401) return { ...REQUEST_ID_HEADER };
  if (status === 429)
    return {
      ...REQUEST_ID_HEADER,
      ...RATE_LIMIT_HEADERS,
      'Retry-After': ref('#/components/headers/Retry-After')
    };
  return { ...REQUEST_ID_HEADER, ...RATE_LIMIT_HEADERS };
}

function response(status: number, spec: PublicApiResponseSpec): Record<string, unknown> {
  const schema = jsonSchema(spec.schema);
  const content: Record<string, unknown> = {};
  for (const type of spec.contentTypes ?? ['application/json']) {
    content[type] =
      type === 'text/event-stream'
        ? {
            schema: {
              type: 'string',
              description: 'Server-sent events; each `data:` line is a JSON-RPC message.'
            }
          }
        : { schema };
  }
  return { description: spec.description, headers: headersFor(status), content };
}

function parameters(route: PublicApiRoute): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [location, schema] of [
    ['path', route.params],
    ['query', route.query]
  ] as const) {
    if (!schema) continue;
    const generated = jsonSchema(schema);
    const required = new Set((generated.required as string[] | undefined) ?? []);
    const properties = (generated.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, property] of Object.entries(properties)) {
      out.push({
        name,
        in: location,
        required: location === 'path' ? true : required.has(name),
        schema: property,
        ...(typeof property.description === 'string' ? { description: property.description } : {})
      });
    }
  }
  return out;
}

function operation(route: PublicApiRoute): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    [String(route.success.status)]: response(route.success.status, route.success)
  };
  for (const [status, spec] of Object.entries(route.protocolResponses ?? {}))
    responses[status] = response(Number(status), spec);
  const errorStatuses = [...new Set([...route.errors, ...ALWAYS_DOCUMENTED_ERRORS])].sort(
    (left, right) => left - right
  );
  for (const status of errorStatuses) {
    responses[String(status)] = {
      description: ERROR_DESCRIPTIONS[status] ?? 'Error.',
      headers: headersFor(status),
      content: { 'application/json': { schema: ref('#/components/schemas/ErrorEnvelope') } }
    };
  }
  const params = parameters(route);
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: [route.tag],
    security:
      route.auth === 'token' ? [{ agentToken: [] }] : [{ agentToken: [] }, { browserSession: [] }],
    'x-trevra-scope': route.scope,
    'x-trevra-rate-limit-class': route.rateLimitClass,
    ...(params.length ? { parameters: params } : {}),
    ...(route.body
      ? {
          requestBody: {
            required: route.bodyRequired === true,
            content: { 'application/json': { schema: jsonSchema(route.body) } }
          }
        }
      : {}),
    responses
  };
}

export function buildOpenApiDocument(
  routes: readonly PublicApiRoute[],
  version: string
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method] = operation(route);
  }
  const limits = DEFAULT_PUBLIC_API_RATE_LIMITS;
  return {
    openapi: '3.1.0',
    info: {
      title: 'Trevra Public API',
      version,
      description:
        'The supported, token-authenticated API for agents and integrations. Routes not in this document are internal and may change without notice. Agents can read and prepare; they can never approve or execute an external write. See docs/api/public-api.md.'
    },
    servers: [{ url: '/', description: 'The Trevra deployment serving this document.' }],
    security: [{ agentToken: [] }],
    tags: [...new Set(routes.map((route) => route.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        agentToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'trv_live_<opaque>',
          description:
            'An Agent token created in Trevra or via POST /api/agent-tokens from a signed-in session. Each token is bound to one workspace and one Agent and carries explicit scopes.'
        },
        browserSession: {
          type: 'apiKey',
          in: 'cookie',
          name: 'trevra.session_token',
          description:
            'A signed-in Trevra browser session. Accepted only by GET /api/v1/openapi.json.'
        }
      },
      schemas: { ErrorEnvelope: jsonSchema(ERROR_ENVELOPE_SCHEMA) },
      headers: {
        'X-Request-Id': {
          description:
            'Echoes a caller-supplied X-Request-Id matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$, otherwise a new UUID.',
          schema: { type: 'string' }
        },
        'X-RateLimit-Limit': {
          description:
            'Requests allowed in the current window for the binding bucket (token or workspace).',
          schema: { type: 'integer' }
        },
        'X-RateLimit-Remaining': {
          description: 'Requests left in the current window for the binding bucket.',
          schema: { type: 'integer' }
        },
        'X-RateLimit-Reset': {
          description: 'Unix time, in seconds, at which the current window ends.',
          schema: { type: 'integer' }
        },
        'Retry-After': {
          description: 'Seconds to wait before retrying.',
          schema: { type: 'integer' }
        }
      }
    },
    'x-trevra-rate-limits': {
      windowSeconds: limits.windowMs / 1000,
      read: { ...limits.read },
      write: { ...limits.write }
    }
  };
}
