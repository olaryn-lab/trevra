import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair, jwtVerify } from 'jose';
import {
  assertNativeGrantClaims,
  nativeTrevraEnabled,
  NATIVE_TREVRA_ORIGIN
} from './native-product-passkey';

const enabled = {
  TREVRA_NATIVE_PASSKEY_ENABLED: 'true',
  NODE_ENV: 'production',
  TREVRA_DEPLOYMENT_MODE: 'hosted',
  AUTHWARD_CLIENT_ID: 'trevra-web',
  APP_ORIGIN: NATIVE_TREVRA_ORIGIN
};
const now = () => Math.floor(Date.now() / 1000);
function payload(nonce: string) {
  return {
    token_use: 'product-passkey-grant',
    origin: NATIVE_TREVRA_ORIGIN,
    rp_id: 'app.usetrevra.com',
    acr: 'urn:olaryn:passkey:uv',
    amr: ['webauthn'],
    email_verified: true,
    sub: 'existing-authward-sub',
    jti: 'jti-unique',
    nonce,
    iat: now(),
    exp: now() + 60
  };
}
describe('Trevra native passkey grant boundary', () => {
  it('is explicitly rollout-gated; never enabled on localhost or isolated realm', () => {
    expect(nativeTrevraEnabled(enabled)).toBe(true);
    for (const change of [
      { TREVRA_NATIVE_PASSKEY_ENABLED: 'false' },
      { NODE_ENV: 'development' },
      { TREVRA_DEPLOYMENT_MODE: 'self-hosted' },
      { AUTHWARD_ISOLATED_ENABLED: 'true' },
      { AUTHWARD_CLIENT_ID: 'beseam-web' },
      { APP_ORIGIN: 'https://trevra.evil.test' }
    ])
      expect(nativeTrevraEnabled({ ...enabled, ...change })).toBe(false);
  });
  it('rejects replay across nonce, RP, origin, audience claims and time', () => {
    const nonce = 'N'.repeat(48);
    expect(assertNativeGrantClaims(payload(nonce), nonce)).toBe('existing-authward-sub');
    for (const changed of [
      { nonce: 'X'.repeat(48) },
      { origin: 'https://auth.olaryn.com' },
      { rp_id: 'auth.olaryn.com' },
      { email_verified: false },
      { amr: ['google'] },
      { token_use: 'access_token' },
      { acr: 'not-user-verified' },
      { jti: '' },
      { sub: '' },
      { iat: now() - 600 },
      { exp: now() - 1 },
      { exp: now() + 300 }
    ])
      expect(() => assertNativeGrantClaims({ ...payload(nonce), ...changed }, nonce)).toThrow();
  });
  it('requires an issuer/audience-valid signed grant before accepting claims', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA');
    const nonce = 'Q'.repeat(48);
    const token = await new SignJWT(payload(nonce))
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('https://auth.olaryn.com')
      .setAudience('trevra-web')
      .sign(privateKey);
    const valid = (
      await jwtVerify(token, publicKey, {
        issuer: 'https://auth.olaryn.com',
        audience: 'trevra-web',
        algorithms: ['EdDSA']
      })
    ).payload;
    expect(assertNativeGrantClaims(valid, nonce)).toBe('existing-authward-sub');
    await expect(
      jwtVerify(token, publicKey, { issuer: 'https://auth.olaryn.com', audience: 'beseam-web' })
    ).rejects.toThrow();
    await expect(
      jwtVerify(token + 'x', publicKey, {
        issuer: 'https://auth.olaryn.com',
        audience: 'trevra-web'
      })
    ).rejects.toThrow();
  });
});

import { nativeTrevraPasskeyPlugin } from './native-product-passkey';

import { proxyTrevraPasskeyEnrollment } from './native-product-passkey';

describe('enrollment protects fresh ID token from the browser', () => {
  it("looks up only the current user\'s Authward ID token and sends it server-to-server", async () => {
    const original = { ...process.env };
    const previousFetch = globalThis.fetch;
    Object.assign(process.env, enabled);
    const calls: Array<{ url: string; headers: HeadersInit; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers || {},
        body: JSON.parse(String(init?.body))
      });
      return new Response(
        JSON.stringify({
          challengeId: 'verified-test',
          options: { rp: { id: 'app.usetrevra.com' } }
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      );
    };
    const db = {
      query: async (_sql: string, params: unknown[]) => ({
        rows: params[0] === 'expected-user' ? [{ idToken: 'private-identity-token' }] : []
      })
    };
    try {
      const data = await proxyTrevraPasskeyEnrollment(db as never, 'expected-user', 'options', {});
      expect(data).toEqual({
        challengeId: 'verified-test',
        options: { rp: { id: 'app.usetrevra.com' } }
      });
      expect(JSON.stringify(data)).not.toContain('private-identity-token');
      expect(calls[0]?.url).toBe(
        'https://auth.olaryn.com/v1/product-passkeys/trevra-web/registration/options'
      );
      expect(calls[0]?.body).toEqual({ idToken: 'private-identity-token' });
      expect(calls[0]?.headers).toMatchObject({ Origin: NATIVE_TREVRA_ORIGIN });
      await expect(
        proxyTrevraPasskeyEnrollment(db as never, 'other-user', 'options', {})
      ).rejects.toThrow('Sign in again');
      expect(calls).toHaveLength(1);
    } finally {
      process.env = original;
      globalThis.fetch = previousFetch;
    }
  });
});

describe('Trevra native passkey endpoint state machine (controlled proof)', () => {
  it('issues an HttpOnly origin-scoped challenge, requires linked Authward account, and consumes it once', async () => {
    const before = { ...process.env };
    Object.assign(process.env, enabled);
    try {
      const verifier = new Map<string, string>();
      const cookies: Array<{ name: string; value: string; opts: any }> = [];
      const signed: string[] = [];
      let created = 0;
      const adapter = {
        createVerificationValue: async (record: { identifier: string; value: string }) => {
          verifier.set(record.identifier, record.value);
        },
        consumeVerificationValue: async (id: string) => {
          const value = verifier.get(id);
          verifier.delete(id);
          return value ? { value } : null;
        },
        findUserById: async () => ({ id: 'trevra-user', emailVerified: true }),
        createSession: async () => {
          created++;
          return { token: 'only-test-session', userId: 'trevra-user' };
        }
      };
      const pool = { query: async () => ({ rows: [{ userId: 'trevra-user' }] }) };
      let nonce = '';
      const plugin = nativeTrevraPasskeyPlugin(pool as never, async () => payload(nonce));
      const context = {
        internalAdapter: adapter,
        secret: 'unit-test-hmac-secret',
        authCookies: {
          sessionToken: { name: 'trevra.session_token', attributes: { path: '/', httpOnly: true } },
          dontRememberToken: { name: 'trevra.dont_remember', attributes: { path: '/' } }
        },
        options: { session: { cookieCache: { enabled: false } } },
        sessionConfig: { expiresIn: 3600 },
        setNewSession: () => undefined
      };
      const common = {
        context,
        setHeader: () => undefined,
        json: (value: unknown) => value,
        setCookie: (name: string, value: string, opts: unknown) => {
          cookies.push({ name, value, opts });
        },
        getSignedCookie: async () => undefined,
        setSignedCookie: async (name: string) => {
          signed.push(name);
        }
      };
      const headers = new Headers({ origin: NATIVE_TREVRA_ORIGIN });
      await expect(
        plugin.endpoints.trevraNativePasskeyStart({
          ...common,
          headers: new Headers({ origin: 'https://evil.test' })
        } as never)
      ).rejects.toThrow();
      const started = (await plugin.endpoints.trevraNativePasskeyStart({
        ...common,
        headers
      } as never)) as unknown as { nonce: string };
      nonce = started.nonce;
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      expect(verifier.has('trevra-passkey:' + nonce)).toBe(true);
      const complete = async (cookie = nonce) =>
        plugin.endpoints.trevraNativePasskeyComplete({
          ...common,
          headers: new Headers({
            origin: NATIVE_TREVRA_ORIGIN,
            cookie: 'trevra_native_passkey_nonce=' + cookie
          }),
          body: { grant: 'g'.repeat(120) }
        } as never);
      await expect(complete('not-this-nonce')).rejects.toThrow();
      expect(created).toBe(0);
      await expect(complete()).resolves.toEqual({ ok: true });
      expect(created).toBe(1);
      expect(verifier.has('trevra-passkey:' + nonce)).toBe(false);
      await expect(complete()).rejects.toThrow();
      expect(created).toBe(1);
    } finally {
      process.env = before;
    }
  });
});
