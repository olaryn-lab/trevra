import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler } from 'express';
import * as oauth from 'oauth4webapi';
import type { Db } from './db.js';
import { authwardAuthority, isolatedSubject } from './authward-config.js';

export function migrationAuthority(env: NodeJS.ProcessEnv = process.env) {
  const flag = env.AUTHWARD_ACCOUNT_MIGRATION_ENABLED ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('Invalid account migration flag');
  if (flag === 'false') return null;
  const target = authwardAuthority({ ...env, AUTHWARD_ISOLATED_ENABLED: 'true' });
  if (!env.AUTHWARD_ISSUER || env.AUTHWARD_ISSUER.replace(/\/$/, '') === target.issuer)
    throw new Error('Migration requires a separate legacy issuer');
  if (env.AUTHWARD_CLIENT_SECRET?.trim() === target.clientSecret)
    throw new Error('Migration requires separate isolated credentials');
  return target;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
interface Session {
  user: { id: string };
  session: { id: string };
}
interface Attempt {
  user_id: string;
  session_id: string;
  verifier: string;
  nonce: string;
  started_at: Date;
}

export function mountAuthwardLink(
  app: Express,
  db: Db,
  options: {
    authority: ReturnType<typeof migrationAuthority>;
    baseURL: string;
    session: (req: Request) => Promise<Session | null>;
    limiter: RequestHandler;
  }
) {
  const { authority, baseURL } = options;
  const origin = new URL(baseURL).origin;
  const redirectURI = origin + '/api/auth/isolated-link/finish';
  const client: oauth.Client = {
    client_id: authority?.clientId ?? '',
    id_token_signed_response_alg: 'EdDSA'
  };
  async function metadata() {
    if (!authority?.issuer) throw new Error('Disabled');
    const issuer = new URL(authority.issuer);
    const response = await fetch(issuer + '/.well-known/openid-configuration', {
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });
    const as = await oauth.processDiscoveryResponse(issuer, response);
    for (const endpoint of [as.authorization_endpoint, as.token_endpoint, as.jwks_uri]) {
      if (
        !endpoint ||
        new URL(endpoint).protocol !== 'https:' ||
        new URL(endpoint).origin !== issuer.origin
      )
        throw new Error('Untrusted endpoint');
    }
    if (!as.code_challenge_methods_supported?.includes('S256')) throw new Error('PKCE unavailable');
    return as;
  }
  async function live(tx: Db, session: Session) {
    // A cookie cache is not proof of an unrevoked session. Lock against logout
    // through the final mapping commit; never change the session or membership.
    const row = await tx
      .prepare('SELECT id FROM session WHERE id=? AND "userId"=? AND "expiresAt">now() FOR UPDATE')
      .get(session.session.id, session.user.id);
    if (!row) throw new Error('Session expired');
    const legacy = await tx
      .prepare(
        `SELECT id FROM account WHERE "userId"=? AND "providerId"='authward' AND "accountId" NOT LIKE '[%'`
      )
      .get(session.user.id);
    if (!legacy) throw new Error('Legacy identity required');
  }
  app.get('/api/auth/isolated-link/status', options.limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const session = await options.session(req);
    if (!session) return res.status(401).json({ error: 'Sign in first' });
    const linked = await db
      .prepare('SELECT user_id FROM authward_identity_links WHERE user_id=?')
      .get(session.user.id);
    res.json({ enabled: Boolean(authority), linked: Boolean(linked) });
  });
  app.post('/api/auth/isolated-link/begin', options.limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!authority) return res.sendStatus(404);
    // Strict Origin, including rejection of missing/null origins, prevents login CSRF.
    if (req.get('origin') !== origin) return res.sendStatus(403);
    try {
      const session = await options.session(req);
      if (!session) return res.sendStatus(401);
      const as = await metadata();
      const state = random(),
        nonce = random(),
        verifier = oauth.generateRandomCodeVerifier();
      const challenge = await oauth.calculatePKCECodeChallenge(verifier);
      await db.transaction(async (tx) => {
        await live(tx, session);
        if (
          await tx
            .prepare('SELECT user_id FROM authward_identity_links WHERE user_id=?')
            .get(session.user.id)
        )
          throw new Error('Already linked');
        await tx
          .prepare('DELETE FROM authward_link_attempts WHERE session_id=? OR expires_at<now()')
          .run(session.session.id);
        await tx
          .prepare(
            `INSERT INTO authward_link_attempts (state_hash,user_id,session_id,verifier,nonce,expires_at)
          VALUES (?,?,?,?,?,now()+interval '5 minutes')`
          )
          .run(digest(state), session.user.id, session.session.id, verifier, nonce);
      });
      const url = new URL(as.authorization_endpoint!);
      for (const [key, value] of Object.entries({
        client_id: client.client_id,
        redirect_uri: redirectURI,
        response_type: 'code',
        scope: 'openid',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'login',
        max_age: '0'
      }))
        url.searchParams.set(key, value);
      res.json({ url: url.toString() });
    } catch {
      res
        .status(400)
        .json({ error: 'Could not connect. Keep your original session signed in and try again.' });
    }
  });
  app.get('/api/auth/isolated-link/finish', options.limiter, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!authority) return res.sendStatus(404);
    try {
      const session = await options.session(req);
      if (!session) throw new Error('Missing session');
      const params = new URL(req.originalUrl, origin).searchParams;
      const state = params.get('state');
      if (!state || params.getAll('state').length !== 1) throw new Error('Missing state');
      // Burn before network I/O, even on invalid tokens. Concurrent callbacks
      // cannot redeem this attempt twice; another session cannot burn it.
      const attempt = await db.transaction(async (tx) => {
        await live(tx, session);
        return tx
          .prepare(
            `DELETE FROM authward_link_attempts WHERE state_hash=? AND user_id=? AND session_id=? AND expires_at>now()
          RETURNING user_id,session_id,verifier,nonce,started_at`
          )
          .get<Attempt>(digest(state), session.user.id, session.session.id);
      });
      if (!attempt) throw new Error('Invalid attempt');
      const as = await metadata();
      const validated = oauth.validateAuthResponse(as, client, params, state);
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.ClientSecretBasic(authority.clientSecret!),
        validated,
        redirectURI,
        attempt.verifier,
        { signal: AbortSignal.timeout(5000) }
      );
      const claims = await verifyLinkIdentity(
        as,
        client,
        response,
        attempt.nonce,
        attempt.started_at
      );
      const accountId = isolatedSubject(authority.issuer!, claims);
      await db.transaction(async (tx) => {
        await live(tx, session);
        // Serialize against all migrations of this user; the identity ledger's
        // unique issuer/subject constraint arbitrates different users racing.
        await tx.prepare('SELECT id FROM "user" WHERE id=? FOR UPDATE').get(session.user.id);
        const existing = await tx
          .prepare(
            `SELECT id FROM account WHERE "providerId"='authward' AND ("accountId"=? OR ("userId"=? AND "accountId" LIKE '[%'))`
          )
          .get(accountId, session.user.id);
        if (existing) throw new Error('Conflicting account');
        await tx
          .prepare('INSERT INTO authward_identity_links (issuer,subject,user_id) VALUES (?,?,?)')
          .run(authority.issuer, claims.sub, session.user.id);
        await tx
          .prepare(
            `INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES (?,?,'authward',?,now(),now())`
          )
          .run(randomUUID(), accountId, session.user.id);
      });
      res.redirect(303, '/setup/workspace?accountLink=connected');
    } catch {
      res.redirect(303, '/setup/workspace?accountLink=failed');
    }
  });
}

/** Verify every identity claim and the asymmetric JWT signature before any write. */
export async function verifyLinkIdentity(
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  response: Response,
  nonce: string,
  startedAt: Date
) {
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
    expectedNonce: nonce,
    requireIdToken: true,
    maxAge: 300
  });
  await oauth.validateApplicationLevelSignature(as, response, {
    signal: AbortSignal.timeout(5000)
  });
  const claims = oauth.getValidatedIdTokenClaims(tokens)!;
  if (
    typeof claims.auth_time !== 'number' ||
    claims.auth_time < Math.floor(new Date(startedAt).getTime() / 1000) - 5
  )
    throw new Error('Fresh authentication required');
  isolatedSubject(as.issuer, claims);
  return claims;
}
