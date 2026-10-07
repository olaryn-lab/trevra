import { getNango } from '../integration-service.js';

/**
 * GitHub over the Nango proxy. Nango holds the token and refreshes it; this
 * file only shapes requests and reads GitHub's answers.
 *
 * NO NANGO-SIDE RETRIES ARE ASKED FOR. With retries above zero Nango backs off
 * on a 429 and honours GitHub's reset header -- up to ten minutes per call --
 * which would hold the workspace's automation lease for the duration.
 * Whether Nango retries rests on the Nango server's default, not on the
 * `retries: 0` passed below: the installed SDK drops a falsy `retries`, so
 * that value never reaches Nango. A rate limit is a schedule, not an error:
 * `GitHubClient` turns it into a reset time and the poller simply comes back
 * then. That is not a rebuilt rate limiter; it reads the limit GitHub states
 * and waits for it.
 */

export interface GitHubRequest {
  params?: Record<string, string | number>;
  headers?: Record<string, string>;
}

export interface GitHubResponse {
  status: number;
  data: unknown;
  /** Header names lower-cased. */
  headers: Record<string, string>;
}

/** Never throws on an HTTP status: a 304, a 404 or a 403 is an answer, not an exception. */
export interface GitHubTransport {
  get(endpoint: string, request?: GitHubRequest): Promise<GitHubResponse>;
}

export const GITHUB_ACCEPT = 'application/vnd.github+json';
/** Adds `starred_at` to each stargazer. */
export const GITHUB_STAR_ACCEPT = 'application/vnd.github.star+json';
export const GITHUB_API_VERSION = '2022-11-28';
/** Requests left untouched in the hour, so a poll never drains the founder's whole budget. */
export const RATE_LIMIT_RESERVE = 50;
const DEFAULT_RESET_MS = 60 * 60_000;

/** The slice of `Nango` this file uses; tests pass a fake. */
export interface NangoProxyLike {
  get(config: {
    endpoint: string;
    providerConfigKey: string;
    connectionId: string;
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
    retries?: number;
  }): Promise<{ status: number; data: unknown; headers: unknown }>;
}

export function lowerCaseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

export function nangoGitHubTransport(
  connection: { providerConfigKey: string; connectionId: string },
  nango: NangoProxyLike = getNango()
): GitHubTransport {
  return {
    async get(endpoint: string, request: GitHubRequest = {}): Promise<GitHubResponse> {
      try {
        const response = await nango.get({
          endpoint,
          providerConfigKey: connection.providerConfigKey,
          connectionId: connection.connectionId,
          params: request.params,
          headers: {
            Accept: GITHUB_ACCEPT,
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            ...request.headers
          },
          retries: 0
        });
        return {
          status: response.status,
          data: response.data,
          headers: lowerCaseHeaders(response.headers)
        };
      } catch (error) {
        // The SDK is axios underneath: any non-2xx (304 included) rejects with
        // the answer attached. Hand the answer back; rethrow only when there
        // was no answer at all.
        const response = (
          error as { response?: { status?: unknown; data?: unknown; headers?: unknown } }
        ).response;
        if (response && typeof response.status === 'number') {
          return {
            status: response.status,
            data: response.data,
            headers: lowerCaseHeaders(response.headers)
          };
        }
        throw error;
      }
    }
  };
}

export class GitHubRateLimitedError extends Error {
  constructor(readonly resetAt: Date) {
    super(`GitHub rate limit reached; polling resumes at ${resetAt.toISOString()}`);
    this.name = 'GitHubRateLimitedError';
  }
}

export class GitHubConnectionRevokedError extends Error {
  constructor(message = 'GitHub rejected the stored authorization. Reconnect GitHub.') {
    super(message);
    this.name = 'GitHubConnectionRevokedError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(readonly endpoint: string) {
    super(`GitHub has nothing at ${endpoint}`);
    this.name = 'GitHubNotFoundError';
  }
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    endpoint: string
  ) {
    super(`GitHub answered ${status} for ${endpoint}`);
    this.name = 'GitHubRequestError';
  }
}

function headerNumber(headers: Record<string, string>, name: string): number | null {
  const raw = headers[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** What GitHub said about the budget: `retry-after` wins, then the reset epoch. */
export function rateLimitFrom(
  headers: Record<string, string>,
  now: Date
): { remaining: number | null; resetAt: Date | null } {
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const retryAfter = headerNumber(headers, 'retry-after');
  const resetEpoch = headerNumber(headers, 'x-ratelimit-reset');
  const resetAt =
    retryAfter !== null
      ? new Date(now.getTime() + retryAfter * 1000)
      : resetEpoch !== null
        ? new Date(resetEpoch * 1000)
        : null;
  return { remaining, resetAt };
}

/** Nango's own error body: `{ error: { code, message } }`. GitHub never answers in that shape. */
function nangoErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const error = (data as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * Nango error codes meaning THIS connection cannot be used until the founder
 * reconnects. Taken from the installed Nango types:
 * - `unknown_connection`: @nangohq/types connection/api/get.d.ts (proxy/get connection errors)
 * - `failed_to_refresh`: @nangohq/types connection/api/get.d.ts (token refresh failed)
 * - `connection_not_found`: @nangohq/types gettingStarted/api.d.ts, functions/api.d.ts
 * Deliberately excluded: `unknown_provider_config` and auth/key errors, which
 * are platform faults a reconnect cannot fix.
 */
const REVOKED_NANGO_CODES: ReadonlySet<string> = new Set([
  'unknown_connection',
  'failed_to_refresh',
  'connection_not_found'
]);

/** GitHub's secondary / abuse limit answers 403 without a retry-after header. */
const RATE_LIMIT_MESSAGE = /rate limit|abuse|secondary/i;

function messageOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * One poll run's view of GitHub. Tracks the rate-limit budget across calls and
 * turns every non-answer into a typed error the poller can act on.
 */
export class GitHubClient {
  private remaining: number | null = null;
  private resetAt: Date | null = null;

  constructor(
    private readonly transport: GitHubTransport,
    private readonly now: Date
  ) {}

  async get(endpoint: string, request: GitHubRequest = {}): Promise<GitHubResponse> {
    if (this.remaining !== null && this.remaining < RATE_LIMIT_RESERVE) {
      throw new GitHubRateLimitedError(this.resetAt ?? this.fallbackReset());
    }
    const response = await this.transport.get(endpoint, request);
    const limit = rateLimitFrom(response.headers, this.now);
    if (limit.remaining !== null) {
      this.remaining = limit.remaining;
      this.resetAt = limit.resetAt;
    }

    const nangoCode =
      response.status >= 400 && response.status < 500 ? nangoErrorCode(response.data) : null;
    if (nangoCode) {
      // Only a connection-level fault is fixed by reconnecting. Every other
      // Nango code (bad secret key, unknown provider config, ...) is ours to
      // fix: reporting it as revoked would flip a healthy connection to
      // needs-reauth and email the founder for nothing.
      if (REVOKED_NANGO_CODES.has(nangoCode)) {
        throw new GitHubConnectionRevokedError(
          `Nango could not use the GitHub connection (${nangoCode}). Reconnect GitHub.`
        );
      }
      throw new GitHubRequestError(response.status, endpoint);
    }
    if (response.status === 401) throw new GitHubConnectionRevokedError();
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (limit.remaining === 0 ||
          response.headers['retry-after'] !== undefined ||
          RATE_LIMIT_MESSAGE.test(messageOf(response.data))))
    ) {
      // Latch: once limited, this client refuses before touching the wire.
      // If Nango strips the x-ratelimit-* headers the budget gate above can
      // never engage, and only this latch protects the founder's quota.
      const resetAt = limit.resetAt ?? this.fallbackReset();
      this.remaining = 0;
      this.resetAt = resetAt;
      throw new GitHubRateLimitedError(resetAt);
    }
    if (response.status === 404) throw new GitHubNotFoundError(endpoint);
    if (response.status === 304 || (response.status >= 200 && response.status < 300)) {
      return response;
    }
    throw new GitHubRequestError(response.status, endpoint);
  }

  private fallbackReset(): Date {
    return new Date(this.now.getTime() + DEFAULT_RESET_MS);
  }
}
