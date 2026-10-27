import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Better Auth 1.7 hosted Authward authorization start', () => {
  it('preserves the configured callback, PKCE and dynamic upstream request', async () => {
    const issuer = 'https://authward-smoke.example.test/oauth';
    vi.stubEnv('TREVRA_DEPLOYMENT_MODE', 'hosted');
    vi.stubEnv('AUTHWARD_ISOLATED_ENABLED', 'false');
    vi.stubEnv('AUTHWARD_ISSUER', issuer);
    vi.stubEnv('AUTHWARD_CLIENT_ID', 'trevra-smoke-client');
    vi.stubEnv('AUTHWARD_CLIENT_SECRET', 'smoke-confidential-client-secret-not-real');
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:43173');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:43173');

    const requests: string[] = [];
    const { privateKey, publicKey } = await generateKeyPair('EdDSA');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-only-key', use: 'sig', alg: 'EdDSA' };
    let nonce = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const requested = url instanceof Request ? url.url : String(url);
        requests.push(requested);
        if (requested === issuer + '/.well-known/openid-configuration') {
          return new Response(
            JSON.stringify({
              issuer,
              authorization_endpoint: issuer + '/authorize',
              token_endpoint: issuer + '/token',
              userinfo_endpoint: issuer + '/userinfo',
              jwks_uri: issuer + '/jwks',
              response_types_supported: ['code'],
              id_token_signing_alg_values_supported: ['EdDSA']
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (requested === issuer + '/jwks') {
          return new Response(JSON.stringify({ keys: [jwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (requested === issuer + '/token') {
          if (!nonce) throw new Error('Callback attempted before initiating OIDC nonce');
          const idToken = await new SignJWT({
            sub: 'smoke-user-oidc-subject',
            aud: 'trevra-smoke-client',
            nonce,
            email: 'smoke-user@example.test',
            email_verified: true,
            name: 'Smoke OIDC User'
          })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'test-only-key' })
            .setIssuer(issuer)
            .setIssuedAt()
            .setExpirationTime('10m')
            .sign(privateKey);
          return new Response(
            JSON.stringify({
              access_token: 'local-only-access',
              refresh_token: 'local-only-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
              id_token: idToken
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (requested === issuer + '/userinfo') {
          return new Response(
            JSON.stringify({
              sub: 'smoke-user-oidc-subject',
              email: 'smoke-user@example.test',
              email_verified: true,
              name: 'Smoke OIDC User'
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error('Unexpected request to real network during OIDC smoke test: ' + requested);
      })
    );

    vi.resetModules();
    const module = await import('./auth-service.js');
    try {
      await module.migrateAuthDatabase();
      expect(module.authwardAuthEnabled).toBe(true);
      const response = await module.auth.api.signInSocial({
        body: {
          provider: 'authward',
          callbackURL: 'http://localhost:43173/loop',
          errorCallbackURL: 'http://localhost:43173/login',
          additionalParams: {
            resource: 'https://api.usetrevra.com',
            upstream_provider: 'google'
          }
        },
        asResponse: true
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { url?: string };
      expect(result.url).toBeTruthy();
      const url = new URL(result.url!);
      expect(url.origin).toBe(new URL(issuer).origin);
      expect(url.pathname).toBe('/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('trevra-smoke-client');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:43173/api/auth/oauth2/callback/authward'
      );
      expect(url.searchParams.get('upstream_provider')).toBe('google');
      expect(url.searchParams.get('resource')).toBe('https://api.usetrevra.com');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(response.headers.get('set-cookie')).toBeTruthy();
      nonce = url.searchParams.get('nonce') ?? '';
      expect(nonce).toBeTruthy();
      // Complete a signed OIDC callback through Better Auth's real new route.
      // The external provider is entirely mocked; no token or email leaves
      // this disposable process. This is the migration's most critical seam.
      const cookies = response.headers
        .getSetCookie()
        .map((header) => header.split(';')[0])
        .filter(Boolean)
        .join('; ');
      const callback = await module.auth.handler(
        new Request(
          'http://localhost:43173/api/auth/callback/authward?' +
            new URLSearchParams({
              code: 'signed-local-code',
              state: url.searchParams.get('state')!,
              iss: issuer
            }).toString(),
          { headers: { cookie: cookies }, redirect: 'manual' }
        )
      );
      expect(callback.status).toBeGreaterThanOrEqual(300);
      expect(callback.status).toBeLessThan(400);
      const destination = new URL(callback.headers.get('location')!, 'http://localhost:43173');
      expect(destination.pathname).toBe('/loop');
      expect(destination.searchParams.has('error')).toBe(false);
      expect(
        callback.headers.getSetCookie().some((cookie) => cookie.includes('session_token'))
      ).toBe(true);

      // The new OAuth pipeline must retain the provider's immutable sub as its
      // stored account ID. Changing that breaks existing Authward account
      // linkage even if the login page apparently redirects successfully.
      const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const user = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
          'smoke-user@example.test'
        ]);
        expect(user.rows).toHaveLength(1);
        const linked = await client.query<{ accountId: string; providerId: string }>(
          'SELECT "accountId","providerId" FROM account WHERE "userId"=$1 AND "providerId"=$2',
          [user.rows[0]!.id, 'authward']
        );
        expect(linked.rows).toEqual([
          {
            accountId: 'smoke-user-oidc-subject',
            providerId: 'authward'
          }
        ]);
      } finally {
        await client.end();
      }
      expect(requests.every((x) => x.startsWith(issuer))).toBe(true);
    } finally {
      await module.closeAuthDatabase();
    }
  });
});
