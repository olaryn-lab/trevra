import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import pg from 'pg';
import { nativeTrevraPasskeyPlugin, NATIVE_TREVRA_ORIGIN } from './native-product-passkey';
import { migrateAuthDatabase, closeAuthDatabase } from './auth-service';

const { Pool } = pg;
const now = () => Math.floor(Date.now() / 1000);
const authOrigin = NATIVE_TREVRA_ORIGIN;
const nonceCookie = 'trevra_native_passkey_nonce';

let pool: InstanceType<typeof Pool>;
beforeAll(async () => {
  await migrateAuthDatabase();
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
});
afterAll(async () => {
  await pool?.end();
  await closeAuthDatabase();
});

async function responseCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

describe('native passkey login using real Better Auth and PostgreSQL', () => {
  it('mints one authentic signed session cookie only for an existing linked subject and never replays a challenge', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      TREVRA_NATIVE_PASSKEY_ENABLED: 'true',
      NODE_ENV: 'production',
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      AUTHWARD_CLIENT_ID: 'trevra-web',
      APP_ORIGIN: authOrigin
    });
    try {
      let requestedNonce = '';
      let subject = 'external-' + randomUUID();
      const auth = betterAuth({
        appName: 'Trevra-test',
        database: pool,
        baseURL: authOrigin,
        trustedOrigins: [authOrigin],
        secret: 'test-only-native-passkey-session-secret-is-long',
        emailAndPassword: { enabled: true, minPasswordLength: 10 },
        advanced: { cookiePrefix: 'trevra', useSecureCookies: true },
        plugins: [
          nativeTrevraPasskeyPlugin(pool, async () => ({
            sub: subject,
            nonce: requestedNonce,
            jti: randomUUID(),
            origin: authOrigin,
            rp_id: 'app.usetrevra.com',
            email_verified: true,
            acr: 'urn:olaryn:passkey:uv',
            amr: ['webauthn'],
            token_use: 'product-passkey-grant',
            iat: now(),
            exp: now() + 60
          }))
        ]
      });
      const endpoint = async (path: string, body: object, cookie = '') =>
        auth.handler(
          new Request(authOrigin + '/api/auth/' + path, {
            method: 'POST',
            headers: {
              origin: authOrigin,
              'content-type': 'application/json',
              ...(cookie ? { cookie } : {})
            },
            body: JSON.stringify(body)
          })
        );
      const signup = await auth.api.signUpEmail({
        body: {
          email: `native-${randomUUID()}@example.test`,
          name: 'Native Tester',
          password: 'valid-test-password-1234'
        }
      });
      expect(signup.user.id).toBeTruthy();
      await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [signup.user.id]);
      await pool.query(
        `INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
        VALUES($1,$2,'authward',$3,now(),now())`,
        [randomUUID(), subject, signup.user.id]
      );

      const start = await endpoint('native-passkey/start', {});
      expect(start.status).toBe(200);
      const data = (await start.json()) as { nonce: string };
      requestedNonce = data.nonce;
      expect(start.headers.getSetCookie().join(' ')).toContain(nonceCookie + '=');
      const startCookie = await responseCookies(start);
      const unknownSubject = subject;
      subject = 'unknown-' + randomUUID();
      const missing = await endpoint(
        'native-passkey/complete',
        { grant: 'g'.repeat(120) },
        startCookie
      );
      expect(missing.status).toBe(403);
      subject = unknownSubject;
      // The failed attempt consumes the challenge: no late subject swap can claim it.
      const replay = await endpoint(
        'native-passkey/complete',
        { grant: 'g'.repeat(120) },
        startCookie
      );
      expect(replay.status).toBe(401);

      const second = await endpoint('native-passkey/start', {});
      const secondData = (await second.json()) as { nonce: string };
      requestedNonce = secondData.nonce;
      const complete = await endpoint(
        'native-passkey/complete',
        { grant: 'g'.repeat(120) },
        await responseCookies(second)
      );
      expect(complete.status).toBe(200);
      expect(await complete.json()).toEqual({ ok: true });
      const sessionCookies = complete.headers.getSetCookie();
      expect(sessionCookies.some((c) => c.startsWith('__Secure-trevra.session_token='))).toBe(true);
      const session = await auth.handler(
        new Request(authOrigin + '/api/auth/get-session', {
          headers: { cookie: await responseCookies(complete) }
        })
      );
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user?: { id: string } }).user?.id).toBe(signup.user.id);
      const duplicate = await endpoint(
        'native-passkey/complete',
        { grant: 'g'.repeat(120) },
        await responseCookies(second)
      );
      expect(duplicate.status).toBe(401);
    } finally {
      process.env = previous;
    }
  });
});
