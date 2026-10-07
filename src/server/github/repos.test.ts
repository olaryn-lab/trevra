import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import {
  GitHubRepoError,
  MAX_WATCHED_REPOSITORIES,
  POLL_LEASE_MINUTES,
  claimDueRepositories,
  emptyPollSummary,
  hasDueRepositories,
  listWatchedRepositories,
  markConnectionNeedsReauth,
  parseRepoFullName,
  readGitHubConnection,
  unwatchRepository,
  updateRepository,
  watchRepository
} from './repos.js';

const notificationMock = vi.hoisted(() => ({
  notifyIntegrationNeedsReauth: vi.fn(async () => undefined)
}));
vi.mock('../notifications.js', () => notificationMock);

let db: Db;

const WS = 'ws_github_repos_test';
const OTHER_WS = 'ws_github_repos_other';
const T0 = new Date('2026-10-06T09:00:00.000Z');
const MINUTE = 60_000;

async function resetWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, workspaceId, T0.toISOString());
}

async function addConnection(
  workspaceId: string,
  status: string,
  isDemo: number,
  externalId: string,
  at: Date = T0
): Promise<string> {
  const connectionId = id('conn');
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      connectionId,
      workspaceId,
      'github',
      'trevra-github',
      externalId,
      'GitHub',
      status,
      isDemo,
      at.toISOString(),
      at.toISOString()
    );
  return connectionId;
}

function watch(fullName: string, workspaceId = WS, now = T0) {
  return watchRepository(db, { workspaceId, actorUserId: null, fullName }, now);
}

beforeEach(async () => {
  delete process.env.NANGO_GITHUB_INTEGRATION;
  notificationMock.notifyIntegrationNeedsReauth.mockClear();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetWorkspace(WS);
  await resetWorkspace(OTHER_WS);
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id = ANY(?::text[])').run([WS, OTHER_WS]);
  await db.close();
});

describe('parseRepoFullName', () => {
  it('accepts owner/name and github.com links, and nothing else', () => {
    const lemoncrow = { owner: 'lemoncrow-lab', name: 'lemoncrow' };
    expect(parseRepoFullName('lemoncrow-lab/lemoncrow')).toEqual(lemoncrow);
    expect(parseRepoFullName(' https://github.com/lemoncrow-lab/lemoncrow/ ')).toEqual(lemoncrow);
    expect(parseRepoFullName('github.com/lemoncrow-lab/lemoncrow.git')).toEqual(lemoncrow);
    expect(
      parseRepoFullName('https://www.github.com/lemoncrow-lab/lemoncrow/tree/main?tab=readme')
    ).toEqual(lemoncrow);
    expect(parseRepoFullName('lemoncrow')).toBeNull();
    expect(parseRepoFullName('a/b/c')).toBeNull();
    expect(parseRepoFullName('-bad/name')).toBeNull();
    expect(parseRepoFullName('owner/..')).toBeNull();
    expect(parseRepoFullName('https://gitlab.com/owner/name')).toBeNull();
  });
});

describe('watchRepository', () => {
  it('watches a repository once per workspace, whatever the casing', async () => {
    const first = await watch('lemoncrow-lab/lemoncrow');
    expect(first.created).toBe(true);
    expect(first.repo).toMatchObject({
      workspaceId: WS,
      fullName: 'lemoncrow-lab/lemoncrow',
      url: 'https://github.com/lemoncrow-lab/lemoncrow',
      status: 'pending',
      lastSummary: null,
      unresolvedTotal: 0,
      nextPollAt: T0.toISOString()
    });

    const again = await watch('https://github.com/LemonCrow-Lab/LemonCrow');
    expect(again.created).toBe(false);
    expect(again.repo.id).toBe(first.repo.id);

    // Another workspace watching the same repository is its own row.
    const other = await watch('lemoncrow-lab/lemoncrow', OTHER_WS);
    expect(other.created).toBe(true);
    expect(other.repo.id).not.toBe(first.repo.id);
  });

  it('refuses a malformed name with 400 and an eleventh repository with 409', async () => {
    await expect(watch('not a repo')).rejects.toMatchObject({ status: 400 });
    for (let index = 0; index < MAX_WATCHED_REPOSITORIES; index += 1) {
      await watch(`lemoncrow-lab/repo-${index}`);
    }
    const refused = await watch('lemoncrow-lab/one-too-many').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GitHubRepoError);
    expect((refused as GitHubRepoError).status).toBe(409);
    // Re-adding one already watched is still fine at the cap.
    await expect(watch('lemoncrow-lab/repo-0')).resolves.toMatchObject({ created: false });
  });

  it('removes a repository only from its own workspace', async () => {
    const { repo } = await watch('lemoncrow-lab/lemoncrow');
    expect(await unwatchRepository(db, OTHER_WS, repo.id)).toBe(false);
    expect(await unwatchRepository(db, WS, repo.id)).toBe(true);
    expect(await listWatchedRepositories(db, WS)).toEqual([]);
  });
});

describe('readGitHubConnection', () => {
  it('tells connected, needs-reconnect and not-connected apart, and ignores demo rows', async () => {
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'not_connected',
      externalConnectionId: null
    });
    await addConnection(WS, 'connected', 1, 'demo');
    expect((await readGitHubConnection(db, WS)).state).toBe('not_connected');
    await addConnection(WS, 'disconnected', 0, 'gone');
    expect((await readGitHubConnection(db, WS)).state).toBe('not_connected');
    await addConnection(WS, 'needs_reauth', 0, 'stale');
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'needs_reauth',
      externalConnectionId: 'stale'
    });
    const liveId = await addConnection(WS, 'connected', 0, 'live');
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'connected',
      localConnectionId: liveId,
      externalConnectionId: 'live',
      providerConfigKey: 'trevra-github',
      lastError: null
    });

    // Another workspace's connection is invisible here.
    expect((await readGitHubConnection(db, OTHER_WS)).state).toBe('not_connected');

    await markConnectionNeedsReauth(
      db,
      WS,
      liveId,
      'GitHub rejected the token',
      new Date(T0.getTime() + MINUTE)
    );
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'needs_reauth',
      localConnectionId: liveId,
      lastError: 'GitHub rejected the token'
    });
  });
});

describe('markConnectionNeedsReauth', () => {
  it('notifies the owners once, however many polls fail in a row', async () => {
    const liveId = await addConnection(WS, 'connected', 0, 'live');
    await markConnectionNeedsReauth(db, WS, liveId, 'GitHub rejected the token', T0);
    await markConnectionNeedsReauth(
      db,
      WS,
      liveId,
      'GitHub rejected the token again',
      new Date(T0.getTime() + MINUTE)
    );
    expect(notificationMock.notifyIntegrationNeedsReauth).toHaveBeenCalledTimes(1);
    expect(notificationMock.notifyIntegrationNeedsReauth).toHaveBeenCalledWith(db, {
      workspaceId: WS,
      provider: 'github',
      accountLabel: 'GitHub',
      reason: 'GitHub rejected the token'
    });
    expect(await readGitHubConnection(db, WS)).toMatchObject({
      state: 'needs_reauth',
      lastError: 'GitHub rejected the token'
    });
  });

  it('does not notify for another workspace or an unknown connection', async () => {
    const liveId = await addConnection(WS, 'connected', 0, 'live');
    await markConnectionNeedsReauth(db, OTHER_WS, liveId, 'nope', T0);
    await markConnectionNeedsReauth(db, WS, 'conn_missing', 'nope', T0);
    expect(notificationMock.notifyIntegrationNeedsReauth).not.toHaveBeenCalled();
    expect((await readGitHubConnection(db, WS)).state).toBe('connected');
  });
});

describe('markConnectionNeedsReauth guards', () => {
  it('leaves a disconnected connection alone and silent', async () => {
    const goneId = await addConnection(WS, 'disconnected', 0, 'gone');
    await markConnectionNeedsReauth(db, WS, goneId, 'late poll failure', T0);
    const row = await db
      .prepare('SELECT status FROM connections WHERE id=?')
      .get<{ status: string }>(goneId);
    expect(row?.status).toBe('disconnected');
    expect(notificationMock.notifyIntegrationNeedsReauth).not.toHaveBeenCalled();
    expect((await readGitHubConnection(db, WS)).state).toBe('not_connected');
  });

  it('still flips the status when the notifier rejects', async () => {
    notificationMock.notifyIntegrationNeedsReauth.mockRejectedValueOnce(new Error('smtp down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const liveId = await addConnection(WS, 'connected', 0, 'live');
    await expect(
      markConnectionNeedsReauth(db, WS, liveId, 'GitHub rejected the token', T0)
    ).resolves.toBeUndefined();
    errors.mockRestore();
    expect((await readGitHubConnection(db, WS)).state).toBe('needs_reauth');
  });
});

describe('claiming due repositories', () => {
  it('claims a due repository once per lease and releases it on update', async () => {
    const { repo } = await watch('lemoncrow-lab/lemoncrow');
    expect(await hasDueRepositories(db, WS, T0)).toBe(true);

    const [claimed] = await claimDueRepositories(db, WS, T0, 10);
    expect(claimed.id).toBe(repo.id);
    // A second worker inside the lease gets nothing.
    expect(await claimDueRepositories(db, WS, T0, 10)).toEqual([]);
    expect(await hasDueRepositories(db, WS, T0)).toBe(false);

    // An abandoned lease expires.
    const afterLease = new Date(T0.getTime() + (POLL_LEASE_MINUTES + 1) * MINUTE);
    expect(await claimDueRepositories(db, WS, afterLease, 10)).toHaveLength(1);

    // Finishing a poll releases the lease and schedules the next one.
    const next = new Date(afterLease.getTime() + 60 * MINUTE);
    await updateRepository(
      db,
      WS,
      repo.id,
      {
        status: 'ok',
        nextPollAt: next,
        lastPolledAt: afterLease,
        starsCursor: new Date('2026-10-05T11:00:00.000Z'),
        repoEtag: '"v1"',
        lastSummary: { ...emptyPollSummary(), stars: 3, unresolved: 1 },
        addUnresolved: 1
      },
      afterLease
    );
    expect(await claimDueRepositories(db, WS, afterLease, 10)).toEqual([]);

    const [stored] = await listWatchedRepositories(db, WS);
    expect(stored).toMatchObject({
      status: 'ok',
      starsCursor: '2026-10-05T11:00:00.000Z',
      repoEtag: '"v1"',
      unresolvedTotal: 1,
      nextPollAt: next.toISOString(),
      lastPolledAt: afterLease.toISOString(),
      lastSummary: { stars: 3, unresolved: 1, forks: 0, burstTruncated: false }
    });
    expect(await claimDueRepositories(db, WS, next, 10)).toHaveLength(1);
  });

  it('never moves a cursor backwards', async () => {
    const { repo } = await watch('lemoncrow-lab/lemoncrow');
    const t1 = new Date('2026-10-05T10:00:00.000Z');
    const t2 = new Date('2026-10-05T12:00:00.000Z');
    await updateRepository(db, WS, repo.id, { starsCursor: t2, forksCursor: t2, issuesCursor: t2 });
    await updateRepository(db, WS, repo.id, { starsCursor: t1, forksCursor: t1, issuesCursor: t1 });
    expect((await listWatchedRepositories(db, WS))[0]).toMatchObject({
      starsCursor: t2.toISOString(),
      forksCursor: t2.toISOString(),
      issuesCursor: t2.toISOString()
    });
    const t3 = new Date('2026-10-05T13:00:00.000Z');
    await updateRepository(db, WS, repo.id, { starsCursor: t3 });
    expect((await listWatchedRepositories(db, WS))[0].starsCursor).toBe(t3.toISOString());
  });

  it('never claims a repository from another workspace', async () => {
    await watch('lemoncrow-lab/lemoncrow', OTHER_WS);
    expect(await hasDueRepositories(db, WS, T0)).toBe(false);
    expect(await claimDueRepositories(db, WS, T0, 10)).toEqual([]);
  });
});

describe('export and erasure', () => {
  it('are found by the workspace catalogue and removed with the workspace', async () => {
    // The same catalogue query app.ts uses for export and erasure.
    const tables = await db
      .prepare(
        `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
           AND t.table_type = 'BASE TABLE'
           AND c.table_name IN ('watched_repositories', 'github_repo_actors')
         ORDER BY c.table_name`
      )
      .all<{ table_name: string }>();
    expect(tables.map((row) => row.table_name)).toEqual([
      'github_repo_actors',
      'watched_repositories'
    ]);

    const tempWs = id('ws');
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(tempWs, 'Erasure probe', T0.toISOString());
    await watch('lemoncrow-lab/lemoncrow', tempWs);
    const accountId = id('acc');
    await db
      .prepare(
        `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?::text[],'active',?,?)`
      )
      .run(
        accountId,
        tempWs,
        'Buyer Co',
        'buyer.io',
        'github',
        ['github-traction'],
        T0.toISOString(),
        T0.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO github_repo_actors
         (id, workspace_id, login, profile_url, account_id, resolved_domain, resolved_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('ghact'),
        tempWs,
        'maya',
        'https://github.com/maya',
        accountId,
        'buyer.io',
        'org_website',
        T0.toISOString(),
        T0.toISOString()
      );

    await db.prepare('DELETE FROM workspaces WHERE id=?').run(tempWs);

    for (const table of ['watched_repositories', 'github_repo_actors']) {
      const row = await db
        .prepare(`SELECT COUNT(*)::int AS count FROM ${table} WHERE workspace_id=?`)
        .get<{ count: number }>(tempWs);
      expect(row?.count).toBe(0);
    }
  });
});
