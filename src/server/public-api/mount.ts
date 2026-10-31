import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod/v3';
import { hasAgentScope, resolveAgentIdentity, type AgentIdentity } from '../agent-access.js';
import type { Db } from '../db.js';
import {
  PublicApiError,
  sendPublicApiError,
  toPublicApiError,
  validationError,
  type PublicApiErrorLocation
} from './errors.js';
import {
  consumePublicApiRateLimit,
  DEFAULT_PUBLIC_API_RATE_LIMITS,
  rateLimitHeaders,
  type PublicApiRateLimitPolicy,
  type PublicApiRequestClass
} from './rate-limit.js';
import { PUBLIC_API_ROUTES, type PublicApiRoute } from './registry.js';

export interface PublicApiSession {
  userId: string;
  workspaceId: string;
}

export interface PublicApiOptions {
  /** Browser-session lookup; consulted only by `token_or_session` routes. */
  readSession(req: Request): Promise<PublicApiSession | null>;
  rateLimits?: PublicApiRateLimitPolicy;
  now?: () => Date;
  /**
   * Runs before a 401 is sent. app.ts uses it to charge a request that skipped
   * the per-address bucket by presenting a session cookie, so a forged cookie
   * cannot buy unmetered 401s here any more than it can on session routes.
   */
  beforeUnauthenticated?: RequestHandler;
}

interface Principal {
  workspaceId: string;
  agent: AgentIdentity | null;
}

const ROUTE_PATTERNS: ReadonlyArray<RegExp> = PUBLIC_API_ROUTES.map((route) =>
  pathPattern(route.path)
);

/** Express matches case-insensitively and tolerates one trailing slash; so does this. */
function pathPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/');
  return new RegExp(`^${source}/?$`, 'i');
}

/**
 * Is this request addressed to a registry path (any method)? Used where a
 * shared middleware answers BEFORE the route runs -- the IP limiter, the origin
 * guard, body parsing -- so those answers wear the public envelope on public
 * paths and keep their historical shape everywhere else.
 */
export function isPublicApiPath(req: Request): boolean {
  const path = (req.originalUrl || req.url).split('?')[0];
  return ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Mount every registry route, then a 405 for other methods on those paths, then
 * an error handler that envelopes failures raised upstream (JSON parsing) for
 * public paths only. Must be called after `express.json()` and before
 * `requireSession`: a path that is not in the registry falls through to the
 * session routes and answers a token with 401, exactly as before.
 */
export function mountPublicApi(app: Express, db: Db, options: PublicApiOptions): void {
  const policy = options.rateLimits ?? DEFAULT_PUBLIC_API_RATE_LIMITS;
  const now = options.now ?? (() => new Date());
  const methodsByPath = new Map<string, string[]>();
  for (const route of PUBLIC_API_ROUTES) {
    app[route.method](route.path, routeHandler(db, route, options, policy, now));
    methodsByPath.set(route.path, [
      ...(methodsByPath.get(route.path) ?? []),
      route.method.toUpperCase()
    ]);
  }
  for (const [path, methods] of methodsByPath) {
    const allow = (methods.includes('GET') ? [...methods, 'HEAD'] : methods).join(', ');
    app.all(path, (req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      sendPublicApiError(
        req,
        res,
        new PublicApiError(405, 'method_not_allowed', `Use ${allow} for this route`, undefined, {
          Allow: allow
        })
      );
    });
  }
  app.use(publicApiErrorHandler);
}

function publicApiErrorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!isPublicApiPath(req) || res.headersSent) return next(error);
  respondWithError(req, res, error);
}

function respondWithError(req: Request, res: Response, error: unknown): void {
  const publicError = toPublicApiError(error);
  if (publicError.status >= 500) req.log.error({ err: error }, 'Public API request failed');
  sendPublicApiError(req, res, publicError);
}

function routeHandler(
  db: Db,
  route: PublicApiRoute,
  options: PublicApiOptions,
  policy: PublicApiRateLimitPolicy,
  now: () => Date
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const principal = await authenticate(db, req, route, options.readSession);
      const decision = await consumePublicApiRateLimit(db, {
        workspaceId: principal.workspaceId,
        tokenId: principal.agent?.tokenId ?? null,
        requestClass: requestClassFor(route, req),
        now: now(),
        policy
      });
      for (const [name, value] of Object.entries(rateLimitHeaders(decision)))
        res.setHeader(name, value);
      if (!decision.allowed)
        throw new PublicApiError(
          429,
          'rate_limited',
          `Too many ${decision.requestClass} requests for this ${decision.bucket} in the current window. Retry after ${decision.retryAfterSeconds}s.`
        );
      if (route.scope && principal.agent && !hasAgentScope(principal.agent, route.scope))
        throw new PublicApiError(
          403,
          'insufficient_scope',
          `Agent token is missing scope: ${route.scope}`
        );
      const result = await route.handler({
        db,
        req,
        res,
        workspaceId: principal.workspaceId,
        agent: principal.agent,
        params: parsePart(route.params, req.params, 'path') as Record<string, string>,
        query: parsePart(route.query, req.query, 'query') as Record<string, unknown>,
        body: route.body ? parsePart(route.body, req.body ?? {}, 'body') : undefined
      });
      if (result && !res.headersSent) res.status(result.status).json(result.body);
    } catch (error) {
      if (res.headersSent) {
        // A streamed (MCP) response failed midway: the status line is gone.
        req.log.error({ err: error }, 'Public API response failed after headers were sent');
        if (!res.writableEnded) res.end();
        return;
      }
      const publicError = toPublicApiError(error);
      if (publicError.status === 401 && options.beforeUnauthenticated)
        return options.beforeUnauthenticated(req, res, () =>
          respondWithError(req, res, publicError)
        );
      respondWithError(req, res, error);
    }
  };
}

async function authenticate(
  db: Db,
  req: Request,
  route: PublicApiRoute,
  readSession: PublicApiOptions['readSession']
): Promise<Principal> {
  const agent = await resolveAgentIdentity(db, req.headers);
  if (agent) return { workspaceId: agent.workspaceId, agent };
  if (route.auth === 'token_or_session') {
    const session = await readSession(req);
    if (session) return { workspaceId: session.workspaceId, agent: null };
  }
  throw new PublicApiError(
    401,
    'unauthenticated',
    route.auth === 'token'
      ? 'Valid Trevra agent token required'
      : 'Valid Trevra agent token or signed-in session required',
    undefined,
    { 'WWW-Authenticate': 'Bearer realm="trevra"' }
  );
}

function requestClassFor(route: PublicApiRoute, req: Request): PublicApiRequestClass {
  if (route.rateLimitClass !== 'jsonrpc_method') return route.rateLimitClass;
  const body: unknown = req.body;
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'tools/call'
  )
    ? 'write'
    : 'read';
}

function parsePart(
  schema: z.ZodTypeAny | undefined,
  value: unknown,
  location: PublicApiErrorLocation
): unknown {
  if (!schema) return location === 'body' ? value : {};
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(location, parsed.error);
  return parsed.data;
}
