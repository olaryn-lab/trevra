import type { Db } from '../db.js';

/**
 * Public API rate limits (TRV-053): a PostgreSQL fixed-window counter shared by
 * every API instance (migration 157). Each authenticated public request is
 * charged to TWO buckets of its class -- its own token, and its workspace -- in
 * one statement:
 *
 *   1. the token bucket is incremented;
 *   2. ONLY if the token is still within its limit is the workspace bucket
 *      incremented, so one runaway credential cannot burn the budget of every
 *      other credential in the same workspace once it is already refused.
 *
 * Session callers (only `GET /api/v1/openapi.json` accepts them) have no token
 * and are charged to the workspace bucket alone. Internal session routes are
 * not touched by this limiter.
 */

export type PublicApiRequestClass = 'read' | 'write';

export interface PublicApiRateLimitPolicy {
  windowMs: number;
  read: { token: number; workspace: number };
  write: { token: number; workspace: number };
}

export const DEFAULT_PUBLIC_API_RATE_LIMITS: PublicApiRateLimitPolicy = Object.freeze({
  windowMs: 60_000,
  read: Object.freeze({ token: 120, workspace: 600 }),
  write: Object.freeze({ token: 30, workspace: 120 })
});

/** Closed windows are kept this long, then `prunePublicApiRateWindows` removes them. */
export const PUBLIC_API_RATE_WINDOW_RETENTION_MS = 60 * 60 * 1000;

export interface PublicApiRateDecision {
  allowed: boolean;
  /** The bucket the headers describe: the one that refused, else the tighter one. */
  bucket: 'token' | 'workspace';
  requestClass: PublicApiRequestClass;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

export async function consumePublicApiRateLimit(
  db: Db,
  input: {
    workspaceId: string;
    tokenId: string | null;
    requestClass: PublicApiRequestClass;
    now: Date;
    policy: PublicApiRateLimitPolicy;
  }
): Promise<PublicApiRateDecision> {
  const { windowMs } = input.policy;
  const limits = input.policy[input.requestClass];
  const windowStartMs = Math.floor(input.now.getTime() / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs).toISOString();
  const resetAt = new Date(windowStartMs + windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((resetAt.getTime() - input.now.getTime()) / 1000)
  );

  let tokenHits: number | null = null;
  let workspaceHits: number | null = null;
  if (input.tokenId) {
    const row = await db
      .prepare(
        `
      WITH token_bucket AS (
        INSERT INTO public_api_rate_windows (workspace_id,subject,request_class,window_start,hits)
        VALUES (?,?,?,?::timestamptz,1)
        ON CONFLICT (workspace_id,subject,request_class,window_start)
        DO UPDATE SET hits=public_api_rate_windows.hits+1
        RETURNING hits
      ), workspace_bucket AS (
        INSERT INTO public_api_rate_windows (workspace_id,subject,request_class,window_start,hits)
        SELECT ?,'workspace',?,?::timestamptz,1 FROM token_bucket WHERE token_bucket.hits <= ?::int
        ON CONFLICT (workspace_id,subject,request_class,window_start)
        DO UPDATE SET hits=public_api_rate_windows.hits+1
        RETURNING hits
      )
      SELECT (SELECT hits FROM token_bucket) AS token_hits,
             (SELECT hits FROM workspace_bucket) AS workspace_hits
    `
      )
      .get<{ token_hits: number | null; workspace_hits: number | null }>(
        input.workspaceId,
        `token:${input.tokenId}`,
        input.requestClass,
        windowStart,
        input.workspaceId,
        input.requestClass,
        windowStart,
        limits.token
      );
    tokenHits = row?.token_hits == null ? null : Number(row.token_hits);
    workspaceHits = row?.workspace_hits == null ? null : Number(row.workspace_hits);
  } else {
    const row = await db
      .prepare(
        `
      INSERT INTO public_api_rate_windows (workspace_id,subject,request_class,window_start,hits)
      VALUES (?,'workspace',?,?::timestamptz,1)
      ON CONFLICT (workspace_id,subject,request_class,window_start)
      DO UPDATE SET hits=public_api_rate_windows.hits+1
      RETURNING hits
    `
      )
      .get<{ hits: number }>(input.workspaceId, input.requestClass, windowStart);
    workspaceHits = row ? Number(row.hits) : null;
  }

  const decide = (
    bucket: 'token' | 'workspace',
    hits: number,
    limit: number
  ): PublicApiRateDecision => ({
    allowed: hits <= limit,
    bucket,
    requestClass: input.requestClass,
    limit,
    remaining: Math.max(0, limit - hits),
    resetAt,
    retryAfterSeconds
  });

  const token = tokenHits === null ? null : decide('token', tokenHits, limits.token);
  if (token && !token.allowed) return token;
  // A token request inside its own limit always reaches the workspace upsert,
  // so a missing workspace count here means the statement returned nothing --
  // fail closed rather than serve an unmetered request.
  if (workspaceHits === null) return decide('workspace', limits.workspace + 1, limits.workspace);
  const workspace = decide('workspace', workspaceHits, limits.workspace);
  if (!workspace.allowed || !token) return workspace;
  return workspace.remaining < token.remaining ? workspace : token;
}

export function rateLimitHeaders(decision: PublicApiRateDecision): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(Math.ceil(decision.resetAt.getTime() / 1000)),
    ...(decision.allowed ? {} : { 'Retry-After': String(decision.retryAfterSeconds) })
  };
}

/** The closer for migration 157: drop windows that ended more than an hour ago. */
export async function prunePublicApiRateWindows(
  db: Db,
  now: Date = new Date(),
  retentionMs: number = PUBLIC_API_RATE_WINDOW_RETENTION_MS
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  const result = await db
    .prepare('DELETE FROM public_api_rate_windows WHERE window_start < ?::timestamptz')
    .run(cutoff);
  return result.changes;
}
