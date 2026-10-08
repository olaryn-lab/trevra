import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { MAX_CAPTURE_BODY_BYTES } from '../lead-capture/signature.js';
import { createCaptureSource, setCaptureSourceStatus } from '../lead-capture/sources.js';
import { CITATION_SOURCE_KIND } from '../lead-capture/types.js';
import { createWatch, type BrandWatch } from './store.js';

let db: Db;
let app: Express;
let session = '';
let watch: BrandWatch;
const WORKSPACE_ID = 'ws_citation_api';
const USER_ID = 'usr_citation_api';
const CITATIONS = '/api/intake/v1/citations';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Citation API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'citation-api@trevra.test', 'Citation API', now);
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
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    put: (path: string) => request(app).put(path).set('Cookie', cookie)
  };
}

function signedRequest(path: string, sourceId: string, secret: string, key: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`), Buffer.from(body)]))
    .digest('hex');
  return request(app)
    .post(path)
    .set('Content-Type', 'application/json')
    .set('X-Trevra-Source', sourceId)
    .set('X-Trevra-Timestamp', timestamp)
    .set('X-Trevra-Idempotency-Key', key)
    .set('X-Trevra-Signature', `sha256=${signature}`)
    .send(body);
}

const ANSWERED_AT = new Date(Date.now() - 3_600_000).toISOString();

function sampleBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sampleId: 'beseam-api-0001',
    engine: 'perplexity',
    promptRef: 'id:founder-ledger',
    answeredAt: ANSWERED_AT,
    brandCited: true,
    citedUrls: ['https://trevra.com/docs'],
    position: 1,
    ...overrides
  });
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
  await db.prepare('DELETE FROM brand_watches WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM capture_sources WHERE workspace_id=?').run(WORKSPACE_ID);
  watch = await createWatch(
    db,
    WORKSPACE_ID,
    { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
    new Date()
  );
});

// Workspaces whose watches this file created; removed so other files'
// runDueBrandWatches never sees them.
const extraWorkspaces: string[] = [];

afterAll(async () => {
  for (const workspaceId of [WORKSPACE_ID, ...extraWorkspaces])
    await db?.prepare('DELETE FROM brand_watches WHERE workspace_id=?').run(workspaceId);
  await db?.close();
  await closeAuthDatabase();
});

describe('AI-answer citation intake', () => {
  let sourceId = '';
  let secret = '';

  it('connects a watch once and accepts a signed sample as a gained citation', async () => {
    const connected = await authed()
      .put(`/api/watches/${watch.id}/citation-source`)
      .send({ ownedDomains: ['trevra.com'] })
      .expect(201);
    expect(connected.body.secret).toMatch(/^trv_capture_/);
    sourceId = connected.body.citationSource.sourceId;
    secret = connected.body.secret;
    const again = await authed()
      .put(`/api/watches/${watch.id}/citation-source`)
      .send({ ownedDomains: ['trevra.com', 'docs.trevra.com'] })
      .expect(200);
    expect(again.body.secret).toBeNull();
    expect(again.body.citationSource.ownedDomains).toEqual(['docs.trevra.com', 'trevra.com']);

    const accepted = await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-0001',
      sampleBody()
    ).expect(202);
    expect(accepted.body).toMatchObject({
      sampleId: 'beseam-api-0001',
      change: 'gained',
      duplicate: false
    });
    const retried = await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-0001',
      sampleBody()
    ).expect(200);
    expect(retried.body).toMatchObject({ mentionId: accepted.body.mentionId, duplicate: true });

    const mentions = await authed()
      .get(`/api/watches/${watch.id}/mentions?platform=ai_answer`)
      .expect(200);
    expect(mentions.body.mentions).toHaveLength(1);
    expect(mentions.body.mentions[0]).toMatchObject({
      content: '',
      url: 'https://trevra.com/docs'
    });
    const view = await authed().get(`/api/watches/${watch.id}/citation-source`).expect(200);
    expect(view.body.citationSource).toMatchObject({ sourceId, acceptedCount: 2 });
    expect(view.body.citationSource.latestAnsweredAt).toBe(ANSWERED_AT);

    const reply = await authed()
      .post(`/api/watches/${watch.id}/mentions/${accepted.body.mentionId}/reply`)
      .send({ product: {} })
      .expect(409);
    expect(reply.body.error).toBe('AI-answer citations are tracked, not replied to.');
  });

  it('rejects unknown fields such as answer text', async () => {
    const response = await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-text',
      sampleBody({ sampleId: 'beseam-api-text', answerText: 'Trevra is the best ledger.' })
    ).expect(400);
    expect(response.body.error).toMatch(/answerText/);
    const stored = await db
      .prepare('SELECT COUNT(*) AS count FROM ai_citation_samples WHERE sample_id=?')
      .get<{ count: string }>('beseam-api-text');
    expect(Number(stored?.count)).toBe(0);
  });

  it('rejects a foreign cited URL with 400', async () => {
    await signedRequest(
      CITATIONS,
      sourceId,
      secret,
      'citation-api-foreign',
      sampleBody({ sampleId: 'beseam-api-foreign', citedUrls: ['https://trevra.com.evil.io/'] })
    ).expect(400);
  });

  it('a lead source secret cannot post citation samples', async () => {
    const lead = await createCaptureSource(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      name: 'Website form',
      kind: 'website'
    });
    const response = await signedRequest(
      CITATIONS,
      lead.source.id,
      lead.secret,
      'citation-api-lead',
      sampleBody({ sampleId: 'beseam-api-lead' })
    ).expect(403);
    expect(response.body.error).toBe(
      'This capture source does not accept AI-answer citation samples'
    );
  });

  it('answers 413 for an oversize body', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_CAPTURE_BODY_BYTES + 10) });
    await signedRequest(CITATIONS, sourceId, secret, 'citation-api-big', big).expect(413);
  });

  it('refuses an unlinked citation source, a bad signature and an unknown source', async () => {
    const unlinked = await createCaptureSource(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      name: 'Unlinked AI answers',
      kind: CITATION_SOURCE_KIND
    });
    await signedRequest(
      CITATIONS,
      unlinked.source.id,
      unlinked.secret,
      'citation-api-unlinked',
      sampleBody({ sampleId: 'beseam-api-unlinked' })
    ).expect(409);
    await signedRequest(
      CITATIONS,
      sourceId,
      'trv_capture_wrong',
      'citation-api-badsig',
      sampleBody()
    ).expect(401);
    const missing = await signedRequest(
      CITATIONS,
      'cap_missing',
      secret,
      'citation-api-missing',
      sampleBody()
    ).expect(401);
    expect(missing.body).toEqual({ error: 'Invalid capture signature' });
  });

  it('answers an unknown and a disabled source like a bad signature, uncounted', async () => {
    const disabled = await createCaptureSource(db, {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      name: 'Retired AI answers',
      kind: CITATION_SOURCE_KIND
    });
    await setCaptureSourceStatus(db, {
      workspaceId: WORKSPACE_ID,
      sourceId: disabled.source.id,
      status: 'disabled',
      actorUserId: USER_ID
    });
    const counts = async () =>
      (
        await db
          .prepare('SELECT id,rejected_count FROM capture_sources WHERE workspace_id=? ORDER BY id')
          .all<{ id: string; rejected_count: number }>(WORKSPACE_ID)
      ).map((row) => `${row.id}:${Number(row.rejected_count)}`);
    const before = await counts();
    const responses = [
      await signedRequest(CITATIONS, 'cap_missing', secret, 'citation-api-unknown', sampleBody()),
      await signedRequest(
        CITATIONS,
        disabled.source.id,
        disabled.secret,
        'citation-api-disabled',
        sampleBody()
      ),
      await signedRequest(
        CITATIONS,
        sourceId,
        'trv_capture_wrong',
        'citation-api-badsig2',
        sampleBody()
      )
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid capture signature' });
    }
    expect(await counts()).toEqual(before);
  });
});

let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@citation-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
  };
  return { agent, userId: response.body.user.id as string, auth };
}

describe('citation source route guards', () => {
  it('lets a member read but not connect a citation source', async () => {
    const owner = await signUp('citation-owner');
    const member = await signUp('citation-member');
    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: owner.auth.workspaceId })
      .expect(200);
    extraWorkspaces.push(owner.auth.workspaceId);
    const ownedWatch = await createWatch(
      db,
      owner.auth.workspaceId,
      { name: 'Member guard', keywords: ['guard'], platforms: ['hackernews'], cadence: 'daily' },
      new Date()
    );
    const denied = await member.agent
      .put(`/api/watches/${ownedWatch.id}/citation-source`)
      .send({ ownedDomains: ['trevra.com'] })
      .expect(403);
    expect(denied.body.error).toBe(
      'Only the workspace owner can connect AI-answer citation samples'
    );
    const links = await db
      .prepare('SELECT COUNT(*) AS count FROM brand_watch_citation_sources WHERE watch_id=?')
      .get<{ count: string }>(ownedWatch.id);
    expect(Number(links?.count)).toBe(0);
    await member.agent.get(`/api/watches/${ownedWatch.id}/citation-source`).expect(200);

    // Another workspace's owner sees this watch as missing and creates no link.
    const stranger = await signUp('citation-stranger');
    const read = await stranger.agent
      .get(`/api/watches/${ownedWatch.id}/citation-source`)
      .expect(404);
    expect(read.body.error).toBe('Watch not found');
    const write = await stranger.agent
      .put(`/api/watches/${ownedWatch.id}/citation-source`)
      .send({ ownedDomains: ['trevra.com'] })
      .expect(404);
    expect(write.body.error).toBe('Watch not found');
    expect(write.body.secret).toBeUndefined();
    const after = await db
      .prepare('SELECT COUNT(*) AS count FROM brand_watch_citation_sources WHERE watch_id=?')
      .get<{ count: string }>(ownedWatch.id);
    expect(Number(after?.count)).toBe(0);
  });

  it('answers 404 for a watch that does not exist', async () => {
    const read = await authed().get('/api/watches/watch_missing/citation-source').expect(404);
    expect(read.body.error).toBe('Watch not found');
    const write = await authed()
      .put('/api/watches/watch_missing/citation-source')
      .send({ ownedDomains: ['trevra.com'] })
      .expect(404);
    expect(write.body.error).toBe('Watch not found');
  });
});
