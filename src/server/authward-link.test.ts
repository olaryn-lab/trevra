import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import {
  auth,
  closeAuthDatabase,
  migrateAuthDatabase,
  configureAuthProvisioning,
  resolveBetterAuthIdentity
} from './auth-service.js';
import { openDatabase, type Db } from './db.js';
import { mountAuthwardLink } from './authward-link.js';

const issuer = 'https://isolated.example.test/auth';
const origin = 'http://localhost:43173';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'EdDSA', use: 'sig' };
const authority = {
  isolated: true,
  issuer,
  clientId: 'isolated-test',
  clientSecret: 'x'.repeat(32),
  scopes: ['openid']
};
let db: Db;
let app: ReturnType<typeof express>;
let cookie: string;
let userId: string;
let authorization: URL;
let claimsOverride: Record<string, unknown>;
let badSignature: boolean;
let tokenCalls = 0;
const claims = () => ({
  iss: issuer,
  aud: authority.clientId,
  sub: 'isolated-subject',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
  auth_time: Math.floor(Date.now() / 1000),
  nonce: authorization.searchParams.get('nonce'),
  ...claimsOverride
});
function jwt() {
  const encoded = [{ alg: 'EdDSA', kid: 'test-key' }, claims()]
    .map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'))
    .join('.');
  const signature = sign(null, Buffer.from(encoded), privateKey).toString('base64url');
  return encoded + '.' + (badSignature ? Buffer.alloc(64).toString('base64url') : signature);
}
function mount(enabled = true) {
  app = express();
  mountAuthwardLink(app, db, {
    authority: enabled ? authority : null,
    baseURL: origin,
    limiter: (_req, _res, next) => next(),
    session: (req) =>
      auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        query: { disableCookieCache: true }
      })
  });
}
async function begin(sessionCookie = cookie) {
  const response = await request(app)
    .post('/api/auth/isolated-link/begin')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .expect(200);
  authorization = new URL(response.body.url);
  expect(authorization.searchParams.get('resource')).toBe('https://api.usetrevra.com');
  return authorization;
}
function finish(sessionCookie = cookie, state = authorization.searchParams.get('state')!) {
  return request(app)
    .get('/api/auth/isolated-link/finish')
    .query({ state, code: 'fresh-code', iss: issuer })
    .set('Cookie', sessionCookie);
}
async function signup() {
  const response = await auth.api.signUpEmail({
    body: {
      email: randomUUID() + '@example.test',
      password: 'correct horse battery staple',
      name: 'Existing founder'
    },
    asResponse: true
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  const cookies = response.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  return { cookie: cookies, id: body.user.id as string };
}
beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await migrateAuthDatabase();
  configureAuthProvisioning(db);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.close();
  await closeAuthDatabase();
});
beforeEach(async () => {
  vi.unstubAllGlobals();
  const user = await signup();
  cookie = user.cookie;
  userId = user.id;
  await db
    .prepare(
      `INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES (?,?,'authward',?,now(),now())`
    )
    .run(randomUUID(), 'legacy-' + randomUUID(), userId);
  await resolveBetterAuthIdentity(db, { cookie });
  claimsOverride = { sub: randomUUID() };
  badSignature = false;
  tokenCalls = 0;
  mount();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration'))
        return Response.json({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['EdDSA'],
          authorization_response_iss_parameter_supported: true
        });
      if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/token')) {
        tokenCalls++;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('redirect_uri')).toBe(origin + '/api/auth/isolated-link/finish');
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
          authorization.searchParams.get('code_challenge')
        );
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Basic /);
        return Response.json({ access_token: 'unused', token_type: 'Bearer', id_token: jwt() });
      }
      throw new Error('Unexpected request');
    })
  );
});

describe('explicit legacy account migration with real Better Auth and PostgreSQL', () => {
  it('links a signed subject with a different email to the same user and preserves the old session', async () => {
    const protectedBefore = await Promise.all(
      ['workspaces', 'users', 'member', 'organization'].map((table) =>
        db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()
      )
    );
    const before = await db.prepare('SELECT * FROM session WHERE "userId"=?').all(userId);
    await begin();
    expect(authorization.searchParams.get('prompt')).toBe('login');
    expect(authorization.searchParams.get('max_age')).toBe('0');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    claimsOverride.email = 'unrelated@example.test';
    const result = await finish();
    expect(result.headers.location).toContain('accountLink=connected');
    const mapping = await db
      .prepare('SELECT * FROM authward_identity_links WHERE user_id=?')
      .get(userId);
    expect(mapping?.subject).toBe(claimsOverride.sub);
    const account = await db
      .prepare(`SELECT * FROM account WHERE "accountId"=? AND "providerId"='authward'`)
      .get(JSON.stringify([issuer, claimsOverride.sub]));
    expect(account?.userId).toBe(userId);
    expect(account?.accessToken).toBeNull();
    expect(
      await Promise.all(
        ['workspaces', 'users', 'member', 'organization'].map((table) =>
          db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()
        )
      )
    ).toEqual(protectedBefore);
    expect(await db.prepare('SELECT * FROM session WHERE "userId"=?').all(userId)).toEqual(before);
    expect(
      (
        await auth.api.getSession({
          headers: new Headers({ cookie }),
          query: { disableCookieCache: true }
        })
      )?.user.id
    ).toBe(userId);
    expect((await finish()).headers.location).toContain('accountLink=failed');
    expect(tokenCalls).toBe(1);
    await request(app)
      .post('/api/auth/isolated-link/begin')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .expect(400);
  });
  it('rejects CSRF, absent authentication, disabled feature, and accounts without a legacy identity', async () => {
    await request(app).post('/api/auth/isolated-link/begin').set('Cookie', cookie).expect(403);
    await request(app)
      .post('/api/auth/isolated-link/begin')
      .set('Cookie', cookie)
      .set('Origin', 'https://attacker.test')
      .expect(403);
    await request(app).post('/api/auth/isolated-link/begin').set('Origin', origin).expect(401);
    const other = await signup();
    await request(app)
      .post('/api/auth/isolated-link/begin')
      .set('Cookie', other.cookie)
      .set('Origin', origin)
      .expect(400);
    mount(false);
    await request(app)
      .post('/api/auth/isolated-link/begin')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .expect(404);
    await request(app).get('/api/auth/isolated-link/finish').expect(404);
  });
  it('rejects a different live session of the same user, wrong state, expired attempts and logout', async () => {
    await begin();
    const original = authorization.searchParams.get('state')!;
    expect((await finish(cookie, 'wrong-state')).headers.location).toContain('failed');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    const user = await db
      .prepare('SELECT email FROM "user" WHERE id=?')
      .get<{ email: string }>(userId);
    const second = await auth.api.signInEmail({
      body: { email: user!.email, password: 'correct horse battery staple' },
      asResponse: true
    });
    expect(second.status).toBe(200);
    const secondCookie = second.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    expect((await finish(secondCookie, original)).headers.location).toContain('failed');
    // A different user's valid cookie is also rejected without consuming state.
    const other = await signup();
    expect((await finish(other.cookie, original)).headers.location).toContain('failed');
    expect(tokenCalls).toBe(0);
    await db
      .prepare(
        "UPDATE authward_link_attempts SET expires_at=now()-interval '1 second' WHERE user_id=?"
      )
      .run(userId);
    expect((await finish()).headers.location).toContain('failed');
    await begin();
    await db.prepare('DELETE FROM session WHERE id=?').run(session!.session.id);
    expect((await finish()).headers.location).toContain('failed');
    expect(tokenCalls).toBe(0);
  });
  it.each(['iss', 'aud', 'nonce', 'exp', 'auth_time', 'sub', 'signature'])(
    'rejects invalid %s without mapping and burns the attempt',
    async (field) => {
      await begin();
      if (field === 'signature') badSignature = true;
      else
        claimsOverride[field] = ['exp', 'auth_time'].includes(field)
          ? 1
          : field === 'sub'
            ? ''
            : 'wrong';
      expect((await finish()).headers.location).toContain('failed');
      expect(
        await db.prepare('SELECT * FROM authward_identity_links WHERE user_id=?').get(userId)
      ).toBeUndefined();
      expect(
        await db
          .prepare(`SELECT id FROM account WHERE "userId"=? AND "accountId" LIKE '[%'`)
          .get(userId)
      ).toBeUndefined();
      expect((await finish()).headers.location).toContain('failed');
      expect(tokenCalls).toBe(1);
    }
  );
  it('refuses a subject owned by another user and rolls back the account insert', async () => {
    const other = await signup();
    await db
      .prepare('INSERT INTO authward_identity_links (issuer,subject,user_id) VALUES (?,?,?)')
      .run(issuer, claimsOverride.sub, other.id);
    await begin();
    expect((await finish()).headers.location).toContain('failed');
    expect(
      await db.prepare('SELECT * FROM authward_identity_links WHERE user_id=?').get(userId)
    ).toBeUndefined();
    expect(
      await db
        .prepare(`SELECT id FROM account WHERE "userId"=? AND "accountId" LIKE '[%'`)
        .get(userId)
    ).toBeUndefined();
  });
  it('allows only one of two simultaneous callbacks', async () => {
    await begin();
    const results = await Promise.all([finish(), finish()]);
    expect(results.filter((r) => r.headers.location.includes('connected'))).toHaveLength(1);
    expect(tokenCalls).toBe(1);
    expect(
      await db.prepare('SELECT * FROM authward_identity_links WHERE user_id=?').all(userId)
    ).toHaveLength(1);
  });
});
