import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE_ID = 'ws_enrichment_api';
const USER_ID = 'usr_enrichment_api';
const KEY = 'hunter-api-test-key-0001';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Enrichment API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'enrichment-api@trevra.test', 'Enrichment API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER_ID,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function authed() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    put: (path: string) => request(app).put(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@enrichment-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerAndMember() {
  const owner = await signUp('enrichment-owner');
  const member = await signUp('enrichment-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  return { owner, member };
}

function hunterAnswers(status: number) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => new Response('{"data":{}}', { status }));
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
});

beforeEach(async () => {
  await db
    .prepare("DELETE FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'")
    .run(WORKSPACE_ID);
  await db.prepare('DELETE FROM enrichment_settings WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('enrichment API', () => {
  it('keeps the Hunter key and the cap owner-only', async () => {
    const { member } = await ownerAndMember();
    await member.agent.get('/api/enrichment').expect(200);
    await member.agent.put('/api/enrichment/key').send({ apiKey: KEY }).expect(403);
    await member.agent.delete('/api/enrichment/key').expect(403);
    await member.agent.put('/api/enrichment/cap').send({ monthlyCreditCap: 10 }).expect(403);
  });

  it('checks the key with Hunter before sealing it and never returns it', async () => {
    const spy = hunterAnswers(200);
    const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(200);
    expect(String(spy.mock.calls[0]![0])).toBe('https://api.hunter.io/v2/account');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.settings.keyStatus).toBe('valid');
    expect(JSON.stringify(response.body)).not.toContain(KEY);
    const sealed = await db
      .prepare(
        "SELECT ciphertext FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'"
      )
      .get<{ ciphertext: Buffer }>(WORKSPACE_ID);
    expect(Buffer.from(sealed!.ciphertext).toString('utf8')).not.toContain(KEY);
  });

  it('refuses a key Hunter rejects and saves nothing', async () => {
    hunterAnswers(401);
    const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(400);
    expect(response.body.error).toBe('Hunter rejected this API key. Nothing was saved.');
    expect(await storedKeyId()).toBeUndefined();
  });

  it('refuses a key whose Hunter account has no credits left and saves nothing', async () => {
    hunterAnswers(429);
    const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(400);
    expect(response.body.error).toBe(
      'This Hunter account has no credits left this billing period. Nothing was saved.'
    );
    expect(await storedKeyId()).toBeUndefined();
  });

  it('answers 400 when Hunter refuses the key check for another reason', async () => {
    hunterAnswers(400);
    const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(400);
    expect(response.body.error).toBe('Hunter refused the key check. Nothing was saved.');
    expect(await storedKeyId()).toBeUndefined();
  });

  it('answers 502 and saves nothing when Hunter is down or unreachable', async () => {
    hunterAnswers(503);
    const down = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(502);
    expect(down.body.error).toBe(
      'Hunter could not confirm this key right now. Nothing was saved; try again shortly.'
    );
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(502);
    expect(await storedKeyId()).toBeUndefined();
  });

  it('refuses to store a key when the server has no secrets key', async () => {
    const previous = process.env.TREVRA_SECRETS_KEY;
    delete process.env.TREVRA_SECRETS_KEY;
    try {
      const spy = vi.spyOn(globalThis, 'fetch');
      const response = await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(400);
      expect(response.body.error).toMatch(/no TREVRA_SECRETS_KEY configured/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.TREVRA_SECRETS_KEY = previous;
    }
    expect(await storedKeyId()).toBeUndefined();
  });

  it('seals the key and marks it valid in one transaction', async () => {
    // Make the key-status write fail for this workspace only: the sealed key
    // must roll back with it, never sit in custody without a status.
    await db.exec(`
      CREATE OR REPLACE FUNCTION enrichment_api_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'enrichment_api_test_fail'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER enrichment_api_test_fail BEFORE INSERT OR UPDATE ON enrichment_settings
        FOR EACH ROW WHEN (NEW.workspace_id = '${WORKSPACE_ID}')
        EXECUTE FUNCTION enrichment_api_test_fail();
    `);
    try {
      hunterAnswers(200);
      await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(500);
    } finally {
      await db.exec(`
        DROP TRIGGER IF EXISTS enrichment_api_test_fail ON enrichment_settings;
        DROP FUNCTION IF EXISTS enrichment_api_test_fail();
      `);
    }
    expect(await storedKeyId()).toBeUndefined();
  });

  it('removes the key and reports it missing', async () => {
    hunterAnswers(200);
    await authed().put('/api/enrichment/key').send({ apiKey: KEY }).expect(200);
    const removed = await authed().delete('/api/enrichment/key').expect(200);
    expect(removed.body.settings.keyStatus).toBe('missing');
  });

  it('sets the monthly cap in half-credit steps', async () => {
    const saved = await authed()
      .put('/api/enrichment/cap')
      .send({ monthlyCreditCap: 25.5 })
      .expect(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.body.settings.monthlyCreditCap).toBe(25.5);
    expect(saved.body.usage.usedCredits).toBe(0);
    await authed().put('/api/enrichment/cap').send({ monthlyCreditCap: 0.3 }).expect(400);
    await authed().put('/api/enrichment/cap').send({ monthlyCreditCap: '10' }).expect(400);
    await authed().put('/api/enrichment/cap').send({ monthlyCreditCap: -1 }).expect(400);
  });
});

async function storedKeyId(): Promise<unknown> {
  return db
    .prepare("SELECT id FROM workspace_secrets WHERE workspace_id=? AND kind='hunter_api_key'")
    .get(WORKSPACE_ID);
}
