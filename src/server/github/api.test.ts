import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { id, openDatabase, type Db } from '../db.js';

let db: Db;
let app: ReturnType<typeof createApp>;
let signUpSeq = 0;

beforeAll(async () => {
  delete process.env.NANGO_GITHUB_INTEGRATION;
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

/** A real better-auth user, so owner and member roles are genuine (see app.test.ts). */
async function signUpAgent(label: string) {
  signUpSeq += 1;
  const email = `${label}-${Date.now()}-${signUpSeq}@example.test`;
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  return { agent, userId: (res.body as { user: { id: string } }).user.id };
}

async function sessionAuth(agent: ReturnType<typeof request.agent>) {
  const res = await agent.get('/api/auth/session').expect(200);
  return (res.body as { auth: { userId: string; workspaceId: string; role: 'owner' | 'member' } })
    .auth;
}

async function ownerAndMember() {
  const owner = await signUpAgent('gh-owner');
  const ownerAuth = await sessionAuth(owner.agent);
  const member = await signUpAgent('gh-mate');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: ownerAuth.workspaceId })
    .expect(200);
  expect((await sessionAuth(member.agent)).role).toBe('member');
  return { owner, member };
}

async function insertAccount(workspaceId: string, domain: string, source: string): Promise<string> {
  const accountId = id('acc');
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?::text[],'active',?,?)`
    )
    .run(accountId, workspaceId, domain, domain, source, [], now, now);
  return accountId;
}

describe('GitHub watched-repository API', () => {
  it('lets the owner watch a repository by name or link, idempotently, and shows the connection state', async () => {
    const { agent } = await signUpAgent('gh-watch');
    const first = await agent
      .post('/api/github/repos')
      .send({ fullName: 'https://github.com/lemoncrow-lab/lemoncrow' })
      .expect(201);
    expect(first.body.repo).toMatchObject({
      fullName: 'lemoncrow-lab/lemoncrow',
      url: 'https://github.com/lemoncrow-lab/lemoncrow',
      status: 'pending'
    });
    const again = await agent
      .post('/api/github/repos')
      .send({ fullName: 'LemonCrow-Lab/LemonCrow' })
      .expect(200);
    expect(again.body.repo.id).toBe(first.body.repo.id);

    const listed = await agent.get('/api/github/repos').expect(200);
    expect(listed.body).toMatchObject({ connection: { state: 'not_connected' }, limit: 10 });
    expect(listed.body.repos).toHaveLength(1);
  });

  it('refuses a name that is not a repository and an eleventh repository', async () => {
    const { agent } = await signUpAgent('gh-cap');
    const malformed = await agent
      .post('/api/github/repos')
      .send({ fullName: 'not a repo' })
      .expect(400);
    expect(malformed.body.error).toContain('is not a GitHub repository');
    for (let index = 0; index < 10; index += 1) {
      await agent
        .post('/api/github/repos')
        .send({ fullName: `lemoncrow-lab/repo-${index}` })
        .expect(201);
    }
    const refused = await agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/one-too-many' })
      .expect(409);
    expect(refused.body.error).toContain('at most 10');
  });

  it('lets a member read but not change the watch list', async () => {
    const { owner, member } = await ownerAndMember();
    const created = await owner.agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/lemoncrow' })
      .expect(201);
    const read = await member.agent.get('/api/github/repos').expect(200);
    expect(read.body.repos).toHaveLength(1);
    const refusedAdd = await member.agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/other' })
      .expect(403);
    expect(refusedAdd.body.error).toBe('Only the workspace owner can watch a GitHub repository');
    await member.agent.delete(`/api/github/repos/${created.body.repo.id}`).expect(403);
  });

  it('removes a repository only from its own workspace', async () => {
    const a = await signUpAgent('gh-a');
    const b = await signUpAgent('gh-b');
    const created = await a.agent
      .post('/api/github/repos')
      .send({ fullName: 'lemoncrow-lab/lemoncrow' })
      .expect(201);
    await b.agent.delete(`/api/github/repos/${created.body.repo.id}`).expect(404);
    const removed = await a.agent.delete(`/api/github/repos/${created.body.repo.id}`).expect(200);
    expect(removed.body).toEqual({ removed: true });
    expect((await a.agent.get('/api/github/repos').expect(200)).body.repos).toEqual([]);
  });

  it('includes watched repositories and resolved GitHub logins in the workspace export', async () => {
    const { agent } = await signUpAgent('gh-export');
    const { workspaceId } = await sessionAuth(agent);
    await agent.post('/api/github/repos').send({ fullName: 'lemoncrow-lab/lemoncrow' }).expect(201);
    const accountId = await insertAccount(workspaceId, 'buyer.io', 'github');
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO github_repo_actors
         (id, workspace_id, login, profile_url, account_id, resolved_domain, resolved_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('ghact'),
        workspaceId,
        'maya',
        'https://github.com/maya',
        accountId,
        'buyer.io',
        'org_website',
        now,
        now
      );

    const bundle = (await agent.get('/api/workspace/export').expect(200)).body as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    expect(bundle.tables.watched_repositories.map((row) => `${row.owner}/${row.name}`)).toEqual([
      'lemoncrow-lab/lemoncrow'
    ]);
    expect(bundle.tables.github_repo_actors).toEqual([
      expect.objectContaining({ login: 'maya', profile_url: 'https://github.com/maya' })
    ]);
  });
});

describe('accounts source filter', () => {
  it('filters ranked accounts to the ones GitHub activity created', async () => {
    const { agent } = await signUpAgent('gh-filter');
    const { workspaceId } = await sessionAuth(agent);
    await insertAccount(workspaceId, 'acme.com', 'csv');
    await insertAccount(workspaceId, 'buyer.io', 'github');

    const fromGitHub = await agent.get('/api/accounts?source=github').expect(200);
    expect(
      fromGitHub.body.accounts.map((row: { account: { domain: string } }) => row.account.domain)
    ).toEqual(['buyer.io']);
    expect((await agent.get('/api/accounts').expect(200)).body.accounts).toHaveLength(2);
    await agent.get('/api/accounts?source=nowhere').expect(400);
  });
});
