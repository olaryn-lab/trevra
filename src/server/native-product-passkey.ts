/** Trevra-origin WebAuthn with an Authward verification service, not IdP UI.
 * Credentials are new and scoped to app.usetrevra.com; no legacy key migration.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { APIError } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Pool } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod/v3';

export const NATIVE_TREVRA_ORIGIN = 'https://app.usetrevra.com';
export const NATIVE_TREVRA_CLIENT = 'trevra-web';
const nonceCookie = 'trevra_native_passkey_nonce';
const passkeyBase = 'https://auth.olaryn.com/v1/product-passkeys/trevra-web/';
const jwtKeys = createRemoteJWKSet(
  new URL('/api/auth/.well-known/jwks.json', 'https://auth.olaryn.com')
);

export function nativeTrevraEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.TREVRA_NATIVE_PASSKEY_ENABLED === 'true' &&
    env.NODE_ENV === 'production' &&
    env.TREVRA_DEPLOYMENT_MODE === 'hosted' &&
    env.AUTHWARD_ISOLATED_ENABLED !== 'true' &&
    env.AUTHWARD_CLIENT_ID === NATIVE_TREVRA_CLIENT &&
    env.APP_ORIGIN?.split(',')[0]?.trim() === NATIVE_TREVRA_ORIGIN
  );
}

export function assertNativeGrantClaims(payload: Record<string, unknown>, nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.token_use !== 'product-passkey-grant' ||
    payload.origin !== NATIVE_TREVRA_ORIGIN ||
    payload.rp_id !== 'app.usetrevra.com' ||
    payload.acr !== 'urn:olaryn:passkey:uv' ||
    !Array.isArray(payload.amr) ||
    !payload.amr.includes('webauthn') ||
    payload.email_verified !== true ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.nonce !== 'string' ||
    !nonce ||
    !equalNonce(payload.nonce, nonce) ||
    typeof payload.jti !== 'string' ||
    !payload.jti ||
    typeof payload.iat !== 'number' ||
    payload.iat > now + 30 ||
    payload.iat < now - 90 ||
    typeof payload.exp !== 'number' ||
    payload.exp > payload.iat + 65 ||
    payload.exp <= now
  )
    throw new Error('Invalid Trevra passkey grant');
  return payload.sub;
}
function equalNonce(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function browserCookie(headers: Headers | undefined, name: string) {
  const header = headers?.get('cookie') || '';
  const encoded = header
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + '='));
  return encoded ? encoded.slice(name.length + 1) : '';
}
function checkOrigin(headers: Headers | undefined) {
  if (headers?.get('origin') !== NATIVE_TREVRA_ORIGIN)
    throw new APIError('FORBIDDEN', { message: 'Unexpected passkey origin' });
}

/** Uses Better Auth's OWN session adapter and cookie writer; no forged session rows. */
export function nativeTrevraPasskeyPlugin(
  pool: Pick<Pool, 'query'>,
  validate = async (token: string) =>
    (
      await jwtVerify(token, jwtKeys, {
        issuer: 'https://auth.olaryn.com',
        audience: NATIVE_TREVRA_CLIENT,
        algorithms: ['EdDSA']
      })
    ).payload as Record<string, unknown>
) {
  return {
    id: 'trevra-native-passkey',
    endpoints: {
      trevraNativePasskeyStart: createAuthEndpoint(
        '/native-passkey/start',
        { method: 'POST' },
        async (ctx) => {
          if (!nativeTrevraEnabled()) throw new APIError('NOT_FOUND');
          checkOrigin(ctx.headers);
          const nonce = randomBytes(32).toString('base64url');
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: 'trevra-passkey:' + nonce,
            value: nonce,
            expiresAt: new Date(Date.now() + 5 * 60_000)
          });
          ctx.setCookie(nonceCookie, nonce, {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            path: '/api/auth/native-passkey',
            maxAge: 300
          });
          ctx.setHeader('Cache-Control', 'no-store');
          return ctx.json({ nonce });
        }
      ),
      trevraNativePasskeyComplete: createAuthEndpoint(
        '/native-passkey/complete',
        {
          method: 'POST',
          body: z.object({ grant: z.string().min(100).max(12000) }).strict()
        },
        async (ctx) => {
          if (!nativeTrevraEnabled()) throw new APIError('NOT_FOUND');
          checkOrigin(ctx.headers);
          const nonce = browserCookie(ctx.headers, nonceCookie);
          if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new APIError('UNAUTHORIZED');
          let subject: string;
          try {
            subject = assertNativeGrantClaims(await validate(ctx.body.grant), nonce);
          } catch {
            throw new APIError('UNAUTHORIZED', { message: 'Passkey could not be verified' });
          }
          // A concurrent replay or a grant copied from another device cannot redeem twice.
          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
            'trevra-passkey:' + nonce
          );
          if (!consumed || !equalNonce(consumed.value, nonce)) throw new APIError('UNAUTHORIZED');
          const row = await pool.query<{ userId: string }>(
            `SELECT a."userId" FROM account a JOIN "user" u ON u.id=a."userId"
           WHERE a."providerId"='authward' AND a."accountId"=$1 AND u."emailVerified"=true LIMIT 1`,
            [subject]
          );
          const userId = row.rows[0]?.userId;
          if (!userId)
            throw new APIError('FORBIDDEN', {
              message: 'Sign in with Google or email first to link this account'
            });
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user || !user.emailVerified) throw new APIError('FORBIDDEN');
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR');
          await setSessionCookie(ctx, { session, user });
          ctx.setCookie(nonceCookie, '', {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            path: '/api/auth/native-passkey',
            maxAge: 0
          });
          ctx.setHeader('Cache-Control', 'no-store');
          return ctx.json({ ok: true });
        }
      )
    }
  };
}

export async function proxyTrevraPasskeyEnrollment(
  db: Pick<Pool, 'query'>,
  userId: string,
  phase: 'options' | 'verify',
  data: unknown
) {
  if (!nativeTrevraEnabled()) throw new Error('Native passkeys are unavailable');
  const row = await db.query<{ idToken: string | null }>(
    `SELECT "idToken" FROM account WHERE "providerId"='authward' AND "userId"=$1
     AND "idToken" IS NOT NULL ORDER BY "updatedAt" DESC LIMIT 1`,
    [userId]
  );
  const idToken = row.rows[0]?.idToken;
  if (!idToken) throw new Error('Sign in again with Google or email before adding a passkey');
  const params = z
    .object({ challengeId: z.string().uuid(), response: z.record(z.string(), z.unknown()) })
    .strict();
  const payload = phase === 'options' ? { idToken } : { ...params.parse(data), idToken };
  const response = await fetch(passkeyBase + 'registration/' + phase, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
    headers: { Origin: NATIVE_TREVRA_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok)
    throw new Error(
      response.status === 400
        ? 'Sign in again with Google or email before adding a passkey'
        : 'Passkey enrollment unavailable'
    );
  return response.json();
}
