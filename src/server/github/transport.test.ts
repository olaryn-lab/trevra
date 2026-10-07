import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_API_VERSION,
  GitHubClient,
  GitHubConnectionRevokedError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  GitHubRequestError,
  RATE_LIMIT_RESERVE,
  nangoGitHubTransport,
  rateLimitFrom,
  type GitHubResponse,
  type GitHubTransport
} from './transport.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const RESET_EPOCH = Math.floor(Date.parse('2026-10-06T12:40:00.000Z') / 1000);

function scripted(...responses: GitHubResponse[]): GitHubTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(endpoint: string) {
      calls.push(endpoint);
      const next = responses.shift();
      if (!next) throw new Error('no scripted response left');
      return next;
    }
  };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('nangoGitHubTransport', () => {
  it('asks Nango for the versioned GitHub API, with the caller headers and no Nango-side retries', async () => {
    const get = vi.fn(async (_config: Record<string, unknown>) => ({
      status: 200,
      data: [{ id: 1 }],
      headers: { ETag: '"abc"', 'X-RateLimit-Remaining': '4999' }
    }));
    const transport = nangoGitHubTransport(
      { providerConfigKey: 'trevra-github', connectionId: 'conn-1' },
      { get }
    );
    const response = await transport.get('/repos/lemoncrow-lab/lemoncrow/stargazers', {
      params: { per_page: 100, page: 1 },
      headers: { Accept: 'application/vnd.github.star+json' }
    });
    expect(response).toEqual({
      status: 200,
      data: [{ id: 1 }],
      headers: { etag: '"abc"', 'x-ratelimit-remaining': '4999' }
    });
    expect(get).toHaveBeenCalledWith({
      endpoint: '/repos/lemoncrow-lab/lemoncrow/stargazers',
      providerConfigKey: 'trevra-github',
      connectionId: 'conn-1',
      params: { per_page: 100, page: 1 },
      headers: {
        Accept: 'application/vnd.github.star+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      retries: 0
    });
  });

  it('returns a non-2xx answer instead of throwing it, and rethrows a network failure', async () => {
    const notModified = Object.assign(new Error('Request failed with status code 304'), {
      response: { status: 304, data: '', headers: { etag: '"abc"' } }
    });
    const transport = nangoGitHubTransport(
      { providerConfigKey: 'k', connectionId: 'c' },
      {
        get: vi.fn(async (_config: Record<string, unknown>) => {
          throw notModified;
        })
      }
    );
    await expect(transport.get('/repos/a/b')).resolves.toEqual({
      status: 304,
      data: '',
      headers: { etag: '"abc"' }
    });

    const offline = nangoGitHubTransport(
      { providerConfigKey: 'k', connectionId: 'c' },
      {
        get: vi.fn(async (_config: Record<string, unknown>) => {
          throw new Error('ECONNRESET');
        })
      }
    );
    await expect(offline.get('/repos/a/b')).rejects.toThrow('ECONNRESET');
  });
});

describe('rateLimitFrom', () => {
  it('prefers retry-after, then the reset epoch, and says null when GitHub said nothing', () => {
    expect(rateLimitFrom({ 'retry-after': '120', 'x-ratelimit-remaining': '0' }, NOW)).toEqual({
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 120_000)
    });
    expect(
      rateLimitFrom(
        { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(RESET_EPOCH) },
        NOW
      )
    ).toEqual({ remaining: 12, resetAt: new Date(RESET_EPOCH * 1000) });
    expect(rateLimitFrom({}, NOW)).toEqual({ remaining: null, resetAt: null });
  });
});

describe('GitHubClient', () => {
  it('stops before the budget runs out and names the reset time', async () => {
    const transport = scripted({
      status: 200,
      data: {},
      headers: {
        'x-ratelimit-remaining': String(RATE_LIMIT_RESERVE - 1),
        'x-ratelimit-reset': String(RESET_EPOCH)
      }
    });
    const client = new GitHubClient(transport, NOW);
    await client.get('/repos/a/b');
    const error = await failureOf(client.get('/repos/a/b/stargazers'));
    expect(error).toBeInstanceOf(GitHubRateLimitedError);
    expect((error as GitHubRateLimitedError).resetAt.toISOString()).toBe(
      new Date(RESET_EPOCH * 1000).toISOString()
    );
    expect(transport.calls).toEqual(['/repos/a/b']);
  });

  it('reads an exhausted primary limit, a secondary limit and a 429 as rate limiting', async () => {
    const primary = new GitHubClient(
      scripted({
        status: 403,
        data: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH) }
      }),
      NOW
    );
    expect(await failureOf(primary.get('/users/maya'))).toBeInstanceOf(GitHubRateLimitedError);

    const secondary = new GitHubClient(
      scripted({
        status: 403,
        data: { message: 'secondary rate limit' },
        headers: { 'retry-after': '120' }
      }),
      NOW
    );
    const secondaryError = (await failureOf(
      secondary.get('/users/maya')
    )) as GitHubRateLimitedError;
    expect(secondaryError.resetAt.toISOString()).toBe(
      new Date(NOW.getTime() + 120_000).toISOString()
    );

    const tooMany = new GitHubClient(scripted({ status: 429, data: {}, headers: {} }), NOW);
    const tooManyError = (await failureOf(tooMany.get('/users/maya'))) as GitHubRateLimitedError;
    expect(tooManyError.resetAt.toISOString()).toBe(
      new Date(NOW.getTime() + 3_600_000).toISOString()
    );
  });

  it('treats a 401 or a Nango authorization failure as a revoked connection, not as an empty answer', async () => {
    const unauthorized = new GitHubClient(
      scripted({ status: 401, data: { message: 'Bad credentials' }, headers: {} }),
      NOW
    );
    expect(await failureOf(unauthorized.get('/repos/a/b'))).toBeInstanceOf(
      GitHubConnectionRevokedError
    );
    const nangoRefused = new GitHubClient(
      scripted({
        status: 404,
        data: { error: { code: 'unknown_connection', message: 'No connection' } },
        headers: {}
      }),
      NOW
    );
    expect(await failureOf(nangoRefused.get('/repos/a/b'))).toBeInstanceOf(
      GitHubConnectionRevokedError
    );
  });

  it('separates a missing resource from any other failure, and lets a 304 through', async () => {
    const missing = (await failureOf(
      new GitHubClient(
        scripted({ status: 404, data: { message: 'Not Found' }, headers: {} }),
        NOW
      ).get('/repos/a/b')
    )) as GitHubNotFoundError;
    expect(missing).toBeInstanceOf(GitHubNotFoundError);
    expect(missing.endpoint).toBe('/repos/a/b');

    expect(
      await failureOf(
        new GitHubClient(scripted({ status: 502, data: {}, headers: {} }), NOW).get('/repos/a/b')
      )
    ).toBeInstanceOf(GitHubRequestError);

    await expect(
      new GitHubClient(scripted({ status: 304, data: '', headers: {} }), NOW).get('/repos/a/b')
    ).resolves.toMatchObject({ status: 304 });
  });

  it('only a connection-level Nango code means revoked; other Nango faults are plain request errors', async () => {
    for (const code of ['unknown_connection', 'failed_to_refresh', 'connection_not_found']) {
      const client = new GitHubClient(
        scripted({ status: 400, data: { error: { code, message: 'x' } }, headers: {} }),
        NOW
      );
      expect(await failureOf(client.get('/repos/a/b'))).toBeInstanceOf(
        GitHubConnectionRevokedError
      );
    }
    for (const status of [401, 400, 404]) {
      const client = new GitHubClient(
        scripted({
          status,
          data: { error: { code: 'unknown_provider_config', message: 'x' } },
          headers: {}
        }),
        NOW
      );
      const error = await failureOf(client.get('/repos/a/b'));
      expect(error).toBeInstanceOf(GitHubRequestError);
      expect(error).not.toBeInstanceOf(GitHubConnectionRevokedError);
    }
  });

  it('reads a secondary-limit 403 by its message, but a plain 403 stays a request error', async () => {
    const secondary = new GitHubClient(
      scripted({
        status: 403,
        data: { message: 'You have exceeded a secondary rate limit.' },
        headers: { 'x-ratelimit-remaining': '4000' }
      }),
      NOW
    );
    const limited = (await failureOf(secondary.get('/users/maya'))) as GitHubRateLimitedError;
    expect(limited).toBeInstanceOf(GitHubRateLimitedError);
    expect(limited.resetAt.toISOString()).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());

    for (const message of ['Forbidden', 'Resource protected by organization SAML enforcement']) {
      const plain = new GitHubClient(
        scripted({ status: 403, data: { message }, headers: { 'x-ratelimit-remaining': '4000' } }),
        NOW
      );
      expect(await failureOf(plain.get('/users/maya'))).toBeInstanceOf(GitHubRequestError);
    }
  });

  it('latches a rate limit: the next call on the same client never reaches the wire', async () => {
    const transport = scripted(
      { status: 429, data: {}, headers: { 'retry-after': '90' } },
      { status: 200, data: {}, headers: {} }
    );
    const client = new GitHubClient(transport, NOW);
    expect(await failureOf(client.get('/a'))).toBeInstanceOf(GitHubRateLimitedError);
    const second = (await failureOf(client.get('/b'))) as GitHubRateLimitedError;
    expect(second.resetAt.toISOString()).toBe(new Date(NOW.getTime() + 90_000).toISOString());
    expect(transport.calls).toEqual(['/a']);
  });
});
