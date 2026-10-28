import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAccessToken } from 'better-auth/oauth2';
import { authwardTokenErrorCode, exchangeAuthwardCode } from './authward-token.js';

const issuer = 'https://auth.example.test/api/auth';
const endpoint = issuer + '/oauth2/token';
const callback = 'https://app.usetrevra.com/api/auth/oauth2/callback/authward';
const internalCallback = 'https://app.usetrevra.com/api/auth/callback/authward';

function json(data: object, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Trevra OAuth code exchange', () => {
  it.each([
    { error: 'invalid_client', status: 400, expected: /configuration failure/ },
    { error: 'invalid_client', status: 401, expected: /configuration failure/ },
    { error: 'invalid_grant', status: 400, expected: /authorization code rejected/ },
    { error: 'invalid_grant', status: 401, expected: /authorization code rejected/ }
  ])('branches on $error rather than HTTP $status', async ({ error, status, expected }) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return String(input).endsWith('openid-configuration')
        ? json({ token_endpoint: endpoint })
        : json({ error, error_description: 'private-diagnostic' }, status);
    });
    vi.stubGlobal('fetch', spy);
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        exchangeAuthwardCode(
          issuer,
          'trevra-web',
          'test-password',
          {
            code: 'one-use-code',
            codeVerifier: 'wrong-verifier',
            redirectURI: internalCallback
          },
          callback
        )
      ).rejects.toThrow(expected);
      expect(requests.filter((request) => request.url === endpoint)).toHaveLength(1);
      const tokenRequest = requests.find((request) => request.url === endpoint)!;
      const body = new URLSearchParams(String(tokenRequest.init?.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code_verifier')).toBe('wrong-verifier');
      expect(body.get('resource')).toBe('https://api.usetrevra.com');
      expect(body.get('redirect_uri')).toBe(callback);
      expect(body.get('redirect_uri')).not.toBe(internalCallback);
      expect(new Headers(tokenRequest.init?.headers).get('authorization')).toBe(
        'Basic ' + Buffer.from('trevra-web:test-password').toString('base64')
      );
      expect(JSON.stringify(logger.mock.calls)).not.toContain('private-diagnostic');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('test-password');
      if (error === 'invalid_client') expect(logger).toHaveBeenCalledTimes(1);
      else expect(logger).not.toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });

  it('preserves successful token responses and exchanges once', async () => {
    const spy = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input).endsWith('openid-configuration')
        ? json({ token_endpoint: endpoint })
        : json({ access_token: 'access', refresh_token: 'refresh', expires_in: 900 })
    );
    vi.stubGlobal('fetch', spy);
    const result = await exchangeAuthwardCode(
      issuer,
      'trevra-web',
      'test-password',
      {
        code: 'valid-code',
        codeVerifier: 'valid-verifier',
        redirectURI: internalCallback
      },
      callback
    );
    expect(result.accessToken).toBe('access');
    expect(result.refreshToken).toBe('refresh');
    const grant = spy.mock.calls[1];
    // A simulated Better Auth 1.7 internal callback must not alter the
    // redirect_uri originally bound to the one-time authorization code.
    const actual = new URLSearchParams(String(grant?.[1]?.body));
    expect(actual.get('redirect_uri')).toBe(callback);
    expect(actual.get('redirect_uri')).not.toBe(internalCallback);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-origin token endpoints before sending credentials', async () => {
    const spy = vi.fn(async () =>
      json({ token_endpoint: 'https://other.example.test/oauth2/token' })
    );
    vi.stubGlobal('fetch', spy);
    await expect(
      exchangeAuthwardCode(
        issuer,
        'trevra-web',
        'test-password',
        {
          code: 'code',
          redirectURI: internalCallback
        },
        callback
      )
    ).rejects.toThrow(/unexpected origin/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('existing Better Auth refresh implementation', () => {
  it.each([
    { error: 'invalid_grant', status: 401 },
    { error: 'invalid_client', status: 400 }
  ])('exposes $error on refresh regardless of HTTP $status', async ({ error, status }) => {
    const spy = vi.fn(async () => json({ error }, status));
    vi.stubGlobal('fetch', spy);
    let caught: unknown;
    try {
      await refreshAccessToken({
        refreshToken: 'expired-token',
        options: { clientId: 'trevra-web', clientSecret: 'test-password' },
        tokenEndpoint: endpoint,
        authentication: 'basic'
      });
    } catch (failure) {
      caught = failure;
    }
    expect(authwardTokenErrorCode(caught)).toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
