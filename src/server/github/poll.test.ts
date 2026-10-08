import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { getToday } from '../today.js';
import {
  BUDGET_DEFERRAL_MINUTES,
  ERROR_RETRY_MINUTES,
  GITHUB_POLL_BUDGET_MS,
  MAX_NEW_ACCOUNTS_PER_RUN,
  MAX_STARGAZERS_LISTABLE,
  MAX_STAR_PAGES,
  NOT_FOUND_RETRY_HOURS,
  OWNER_UNREADABLE_ERROR,
  POLL_INTERVAL_MINUTES,
  pollWorkspaceRepositories
} from './poll.js';
import {
  hasDueRepositories,
  listWatchedRepositories,
  watchRepository,
  type WatchedRepository
} from './repos.js';
import type { GitHubRequest, GitHubResponse, GitHubTransport } from './transport.js';

const notificationMock = vi.hoisted(() => ({
  notifyIntegrationNeedsReauth: vi.fn(async () => undefined)
}));
vi.mock('../notifications.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notifications.js')>()),
  notifyIntegrationNeedsReauth: notificationMock.notifyIntegrationNeedsReauth
}));

/**
 * NO NETWORK, NO CLOCK. GitHub is a table of hand-written answers keyed by
 * endpoint, and every `now` is injected. What is proved here is the phase's
 * promise: real companies from public data only, one signal per real event,
 * rejected companies stay rejected, and a revoked token or an exhausted rate
 * limit is a recorded state rather than a quiet zero.
 */

let db: Db;

const WORKSPACE_ID = 'ws_github_poll_test';
const OTHER_WORKSPACE_ID = 'ws_github_poll_other';
const REPO = 'lemoncrow-lab/lemoncrow';
const REPO_PATH = '/repos/lemoncrow-lab/lemoncrow';
const T0 = new Date('2026-10-06T12:00:00.000Z');
const HOUR = 3_600_000;
const RESET_EPOCH = Math.floor(Date.parse('2026-10-06T13:00:00.000Z') / 1000);

interface Call {
  endpoint: string;
  params: Record<string, string | number>;
  headers: Record<string, string>;
}
type Handler = (call: Call) => GitHubResponse;

function ok(data: unknown, headers: Record<string, string> = {}): GitHubResponse {
  return {
    status: 200,
    data,
    headers: {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(RESET_EPOCH),
      ...headers
    }
  };
}

function fakeGitHub(routes: Record<string, Handler>): GitHubTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async get(endpoint: string, request: GitHubRequest = {}) {
      const call = { endpoint, params: request.params ?? {}, headers: request.headers ?? {} };
      calls.push(call);
      const handler = routes[endpoint];
      return handler ? handler(call) : { status: 404, data: { message: 'Not Found' }, headers: {} };
    }
  };
}

const user = (login: string, type = 'User') => ({
  login,
  type,
  html_url: `https://github.com/${login}`
});
const star = (login: string, at: string, type = 'User') => ({
  starred_at: at,
  user: user(login, type)
});

/**
 * The LemonCrow repository and the people around it:
 * - maya works at @buyerco, whose org site is buyer.io (an existing account);
 * - sam has a public company email at newco.dev (no account yet);
 * - lee has only a gmail address, a github.io blog and a plain-text company;
 * - rejectco is an organization the founder already marked not a fit;
 * - old-timer starred long before the backfill window.
 */
function lemoncrowRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [REPO_PATH]: () =>
      ok({ full_name: REPO, stargazers_count: 4, forks_count: 1 }, { etag: '"repo-v1"' }),
    [`${REPO_PATH}/stargazers`]: () =>
      ok([
        star('old-timer', '2026-07-01T00:00:00Z'),
        star('maya', '2026-10-05T09:00:00Z'),
        star('sam', '2026-10-05T10:00:00Z'),
        star('lee', '2026-10-05T11:00:00Z')
      ]),
    [`${REPO_PATH}/forks`]: () =>
      ok([{ created_at: '2026-10-05T12:00:00Z', owner: user('rejectco', 'Organization') }]),
    [`${REPO_PATH}/issues`]: () =>
      ok(
        [
          {
            number: 10,
            html_url: `https://github.com/${REPO}/issues/10`,
            created_at: '2026-10-05T13:30:00Z',
            author_association: 'NONE',
            user: user('dependabot[bot]', 'Bot')
          },
          {
            number: 9,
            html_url: `https://github.com/${REPO}/pull/9`,
            created_at: '2026-10-05T13:20:00Z',
            author_association: 'NONE',
            user: user('sam'),
            pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/9` }
          },
          {
            number: 8,
            html_url: `https://github.com/${REPO}/issues/8`,
            created_at: '2026-10-05T13:10:00Z',
            author_association: 'MEMBER',
            user: user('teammate')
          },
          {
            number: 7,
            html_url: `https://github.com/${REPO}/issues/7`,
            created_at: '2026-10-05T13:00:00Z',
            author_association: 'NONE',
            user: user('maya')
          }
        ],
        { etag: '"issues-v1"' }
      ),
    '/users/maya': () =>
      ok({ ...user('maya'), name: 'Maya', company: '@buyerco', blog: '', email: null }),
    '/orgs/buyerco': () =>
      ok({
        login: 'buyerco',
        name: 'Buyer Co',
        blog: 'https://www.buyer.io',
        html_url: 'https://github.com/buyerco'
      }),
    '/users/sam': () =>
      ok({ ...user('sam'), name: 'Sam', company: 'NewCo', blog: '', email: 'sam@newco.dev' }),
    '/users/lee': () =>
      ok({
        ...user('lee'),
        name: 'Lee',
        company: 'Freelance',
        blog: 'https://lee.github.io',
        email: 'lee@gmail.com'
      }),
    '/users/rejectco': () =>
      ok({ ...user('rejectco', 'Organization'), name: 'Reject Co', blog: 'https://rejectco.com' }),
    // The founder's own organization: the repository owner.
    '/orgs/lemoncrow-lab': () =>
      ok({
        login: 'lemoncrow-lab',
        name: 'LemonCrow',
        blog: 'https://lemoncrow.dev',
        html_url: 'https://github.com/lemoncrow-lab'
      }),
    ...overrides
  };
}

async function resetWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, workspaceId, T0.toISOString());
}

async function connectGitHub(workspaceId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,'github','trevra-github',?,'GitHub','connected',0,?,?)`
    )
    .run(id('conn'), workspaceId, `gh-${workspaceId}`, T0.toISOString(), T0.toISOString());
}

async function makeAccount(workspaceId: string, domain: string, status: string): Promise<string> {
  const accountId = id('acc');
  await db
    .prepare(
      `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
       VALUES (?,?,?,?,'csv',?::text[],?,?,?)`
    )
    .run(accountId, workspaceId, domain, domain, [], status, T0.toISOString(), T0.toISOString());
  return accountId;
}

async function accountByDomain(workspaceId: string, domain: string) {
  return db
    .prepare(
      'SELECT id, name, status, source, tags FROM accounts WHERE workspace_id=? AND LOWER(domain)=?'
    )
    .get<{ id: string; name: string; status: string; source: string; tags: string[] }>(
      workspaceId,
      domain
    );
}

async function signalRows(workspaceId: string, accountId: string) {
  return db
    .prepare(
      `SELECT kind, detail, evidence_url FROM account_signals
       WHERE workspace_id=? AND account_id=? ORDER BY observed_at ASC, id ASC`
    )
    .all<{ kind: string; detail: string; evidence_url: string }>(workspaceId, accountId);
}

async function repoRow(workspaceId = WORKSPACE_ID): Promise<WatchedRepository> {
  const [repo] = await listWatchedRepositories(db, workspaceId);
  return repo;
}

function poll(transport: GitHubTransport, now = T0, workspaceId = WORKSPACE_ID) {
  return pollWorkspaceRepositories(db, workspaceId, { transport, now });
}

beforeEach(async () => {
  notificationMock.notifyIntegrationNeedsReauth.mockClear();
  delete process.env.NANGO_GITHUB_INTEGRATION;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetWorkspace(WORKSPACE_ID);
  await resetWorkspace(OTHER_WORKSPACE_ID);
  await connectGitHub(WORKSPACE_ID);
  await makeAccount(WORKSPACE_ID, 'buyer.io', 'active');
  await makeAccount(WORKSPACE_ID, 'rejectco.com', 'not_a_fit');
  await watchRepository(
    db,
    { workspaceId: WORKSPACE_ID, actorUserId: null, fullName: REPO },
    new Date(T0.getTime() - 60_000)
  );
});

afterEach(async () => {
  await db
    .prepare('DELETE FROM workspaces WHERE id = ANY(?::text[])')
    .run([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
  await db.close();
});

describe('pollWorkspaceRepositories', () => {
  it('attaches a star to an existing company, creates an account for a new one, and only counts a person it cannot trace', async () => {
    const github = fakeGitHub(lemoncrowRoutes());
    const result = await poll(github);
    expect(result).toMatchObject({ connection: 'connected', polled: 1, rateLimitedUntil: null });

    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toEqual([
      {
        kind: 'repo-starred',
        detail: 'starred lemoncrow-lab/lemoncrow',
        evidence_url: 'https://github.com/maya'
      },
      {
        kind: 'repo-issue-opened',
        detail: 'opened an issue on lemoncrow-lab/lemoncrow',
        evidence_url: 'https://github.com/lemoncrow-lab/lemoncrow/issues/7'
      }
    ]);

    const newco = await accountByDomain(WORKSPACE_ID, 'newco.dev');
    expect(newco).toMatchObject({
      status: 'active',
      source: 'github',
      name: 'newco.dev',
      tags: ['github-traction']
    });
    expect((await signalRows(WORKSPACE_ID, newco!.id)).map((row) => row.kind)).toEqual([
      'repo-starred'
    ]);
    expect(result.accountIds.sort()).toEqual([buyer!.id, newco!.id].sort());

    // lee: freemail, a github.io blog and a plain-text company. Counted, never stored.
    expect(await accountByDomain(WORKSPACE_ID, 'gmail.com')).toBeUndefined();
    expect(await accountByDomain(WORKSPACE_ID, 'lee.github.io')).toBeUndefined();
    const actors = await db
      .prepare(
        'SELECT login, profile_url, resolved_domain, resolved_via FROM github_repo_actors WHERE workspace_id=? ORDER BY login'
      )
      .all(WORKSPACE_ID);
    expect(actors).toEqual([
      {
        login: 'maya',
        profile_url: 'https://github.com/maya',
        resolved_domain: 'buyer.io',
        resolved_via: 'org_website'
      },
      {
        login: 'sam',
        profile_url: 'https://github.com/sam',
        resolved_domain: 'newco.dev',
        resolved_via: 'email_domain'
      }
    ]);

    // Outside the backfill window, inside the team, a pull request or a bot:
    // none of them is a buying signal, so none costs a profile lookup.
    const looked = github.calls
      .map((call) => call.endpoint)
      .filter((endpoint) => endpoint.startsWith('/users/'));
    expect(looked.sort()).toEqual(['/users/lee', '/users/maya', '/users/rejectco', '/users/sam']);

    // The stargazer request asked for starred_at.
    const starCall = github.calls.find((call) => call.endpoint.endsWith('/stargazers'));
    expect(starCall?.headers.Accept).toBe('application/vnd.github.star+json');

    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: '2026-10-05T11:00:00.000Z',
      forksCursor: '2026-10-05T12:00:00.000Z',
      issuesCursor: '2026-10-05T13:30:00.000Z',
      repoEtag: '"repo-v1"',
      issuesEtag: '"issues-v1"',
      unresolvedTotal: 1,
      lastPolledAt: T0.toISOString(),
      nextPollAt: new Date(T0.getTime() + POLL_INTERVAL_MINUTES * 60_000).toISOString(),
      lastSummary: {
        stars: 3,
        forks: 1,
        issues: 1,
        attached: 2,
        created: 1,
        unresolved: 1,
        ignoredRejected: 1,
        deferred: 0,
        burstTruncated: false
      }
    });

    // Two kinds from one company, fresh: warm, and scored in the same run.
    const score = await db
      .prepare('SELECT tier FROM account_scores WHERE workspace_id=? AND account_id=?')
      .get<{ tier: string }>(WORKSPACE_ID, buyer!.id);
    expect(score?.tier).toBe('warm');
  });

  it('never reactivates or feeds a company the founder rejected', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    const rejected = await accountByDomain(WORKSPACE_ID, 'rejectco.com');
    expect(rejected?.status).toBe('not_a_fit');
    expect(await signalRows(WORKSPACE_ID, rejected!.id)).toEqual([]);
    expect(
      await db.prepare('SELECT 1 AS one FROM account_scores WHERE account_id=?').get(rejected!.id)
    ).toBeUndefined();

    // Archived after the first run: a remembered login must not bring it back.
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    await db.prepare("UPDATE accounts SET status='archived' WHERE id=?").run(buyer!.id);
    const later = new Date(T0.getTime() + 2 * HOUR);
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/issues`]: () =>
            ok([
              {
                number: 11,
                html_url: `https://github.com/${REPO}/issues/11`,
                created_at: '2026-10-06T13:00:00Z',
                author_association: 'NONE',
                user: user('maya')
              }
            ])
        })
      ),
      later
    );
    expect((await accountByDomain(WORKSPACE_ID, 'buyer.io'))?.status).toBe('archived');
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toHaveLength(2);
    expect((await repoRow()).lastSummary).toMatchObject({
      issues: 1,
      ignoredRejected: 1,
      attached: 0
    });
  });

  it('records the same star once however often it is seen', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    // Maya unstars and stars again: the next poll sees her with a newer starred_at.
    const restar = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () => ok({ stargazers_count: 4, forks_count: 1 }, { etag: '"repo-v2"' }),
        [`${REPO_PATH}/stargazers`]: () =>
          ok([
            star('sam', '2026-10-05T10:00:00Z'),
            star('lee', '2026-10-05T11:00:00Z'),
            star('maya', '2026-10-06T13:30:00Z')
          ])
      })
    );
    await poll(restar, new Date(T0.getTime() + 2 * HOUR));

    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    const stars = (await signalRows(WORKSPACE_ID, buyer!.id)).filter(
      (row) => row.kind === 'repo-starred'
    );
    expect(stars).toHaveLength(1);
    // A remembered person costs no second profile lookup.
    expect(restar.calls.some((call) => call.endpoint === '/users/maya')).toBe(false);
  });

  it('sends ETags back and skips stars and forks when the repository has not changed', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    const unchanged = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: (call) =>
          call.headers['If-None-Match'] === '"repo-v1"'
            ? { status: 304, data: '', headers: {} }
            : ok({ stargazers_count: 4, forks_count: 1 }),
        [`${REPO_PATH}/issues`]: (call) =>
          call.headers['If-None-Match'] === '"issues-v1"'
            ? { status: 304, data: '', headers: {} }
            : ok([])
      })
    );
    await poll(unchanged, new Date(T0.getTime() + 2 * HOUR));
    expect(unchanged.calls.map((call) => call.endpoint)).toEqual([
      REPO_PATH,
      `${REPO_PATH}/issues`
    ]);
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      repoEtag: '"repo-v1"',
      issuesEtag: '"issues-v1"',
      lastSummary: { stars: 0, forks: 0, issues: 0 }
    });
  });

  it('creates at most MAX_NEW_ACCOUNTS_PER_RUN accounts per run and picks up the rest next run', async () => {
    const people = Array.from(
      { length: MAX_NEW_ACCOUNTS_PER_RUN + 2 },
      (_, index) => `person${index + 1}`
    );
    const routes = lemoncrowRoutes({
      [REPO_PATH]: () =>
        ok({ stargazers_count: people.length, forks_count: 0 }, { etag: '"repo-burst"' }),
      [`${REPO_PATH}/stargazers`]: () =>
        ok(people.map((login, index) => star(login, `2026-10-05T0${index + 1}:00:00Z`))),
      [`${REPO_PATH}/forks`]: () => ok([]),
      [`${REPO_PATH}/issues`]: () => ok([])
    });
    people.forEach((login, index) => {
      routes[`/users/${login}`] = () =>
        ok({
          ...user(login),
          email: `${login}@company${index + 1}.dev`,
          company: null,
          blog: null
        });
    });
    const createdDomains = async () =>
      (
        await db
          .prepare(
            "SELECT domain FROM accounts WHERE workspace_id=? AND source='github' ORDER BY domain"
          )
          .all<{ domain: string }>(WORKSPACE_ID)
      ).map((row) => row.domain);

    await poll(fakeGitHub(routes));
    expect(await createdDomains()).toEqual([
      'company1.dev',
      'company2.dev',
      'company3.dev',
      'company4.dev',
      'company5.dev'
    ]);
    const repo = await repoRow();
    expect(repo.lastSummary).toMatchObject({ created: 5, deferred: 2 });
    expect(repo.starsCursor).toBe('2026-10-05T05:00:00.000Z');
    // Cleared so the next run reads the stars again instead of getting a 304.
    expect(repo.repoEtag).toBeNull();

    await poll(fakeGitHub(routes), new Date(T0.getTime() + 2 * HOUR));
    expect(await createdDomains()).toHaveLength(7);
  });

  it('stops at the rate limit, keeps what it processed, and resumes at the reset time', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        '/users/sam': () => ({
          status: 403,
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH) }
        })
      })
    );
    const result = await poll(github);
    const resetAt = new Date(RESET_EPOCH * 1000).toISOString();
    expect(result.rateLimitedUntil).toBe(resetAt);
    expect(await repoRow()).toMatchObject({
      status: 'rate_limited',
      rateLimitedUntil: resetAt,
      nextPollAt: resetAt,
      starsCursor: '2026-10-05T09:00:00.000Z',
      repoEtag: null
    });
    // Maya was processed before the limit and keeps her signal.
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    expect((await signalRows(WORKSPACE_ID, buyer!.id)).map((row) => row.kind)).toEqual([
      'repo-starred'
    ]);
    // Nothing after the limit was requested.
    expect(github.calls.some((call) => call.endpoint.endsWith('/forks'))).toBe(false);
  });

  it('treats an organization GitHub refuses to show as no company and keeps reading the repository', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        // A SAML-protected organization answers 403 to an outside token.
        '/orgs/buyerco': () => ({
          status: 403,
          data: { message: 'Resource protected by organization SAML enforcement.' },
          headers: { 'x-ratelimit-remaining': '4999' }
        })
      })
    );
    const result = await poll(github);
    expect(result.polled).toBe(1);
    const repo = await repoRow();
    expect(repo).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: '2026-10-05T11:00:00.000Z',
      forksCursor: '2026-10-05T12:00:00.000Z',
      issuesCursor: '2026-10-05T13:30:00.000Z',
      // maya's star and issue, and lee: counted, never stored.
      lastSummary: { stars: 3, forks: 1, issues: 1, created: 1, unresolved: 3, ignoredRejected: 1 }
    });
    expect(JSON.stringify(repo)).not.toContain('maya');
    expect(JSON.stringify(repo)).not.toContain('buyerco');
    // Later stars, forks and issues were still read and recorded.
    const newco = await accountByDomain(WORKSPACE_ID, 'newco.dev');
    expect((await signalRows(WORKSPACE_ID, newco!.id)).map((row) => row.kind)).toEqual([
      'repo-starred'
    ]);
    expect(github.calls.some((call) => call.endpoint.endsWith('/forks'))).toBe(true);
    expect(github.calls.some((call) => call.endpoint.endsWith('/issues'))).toBe(true);
  });

  it("never turns the founder's own company or team into a GitHub account", async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () => ok({ stargazers_count: 2, forks_count: 1 }),
        [`${REPO_PATH}/stargazers`]: () =>
          ok([star('crow-dev', '2026-10-05T09:00:00Z'), star('crow-ops', '2026-10-05T09:30:00Z')]),
        // The owner forks its own repository under another casing.
        [`${REPO_PATH}/forks`]: () =>
          ok([
            { created_at: '2026-10-05T12:00:00Z', owner: user('LemonCrow-Lab', 'Organization') }
          ]),
        [`${REPO_PATH}/issues`]: () => ok([]),
        // A teammate: works at the owner org, mails from the owner's website domain.
        '/users/crow-dev': () =>
          ok({
            ...user('crow-dev'),
            company: '@lemoncrow-lab',
            email: 'dev@lemoncrow.dev',
            blog: null
          }),
        // Another teammate with only the owner's domain to go on.
        '/users/crow-ops': () =>
          ok({ ...user('crow-ops'), company: 'LemonCrow', email: 'ops@lemoncrow.dev', blog: null })
      })
    );
    await poll(github);
    expect(await accountByDomain(WORKSPACE_ID, 'lemoncrow.dev')).toBeUndefined();
    const signals = await db
      .prepare('SELECT COUNT(*)::int AS count FROM account_signals WHERE workspace_id=?')
      .get<{ count: number }>(WORKSPACE_ID);
    expect(signals?.count).toBe(0);
    const actors = await db
      .prepare('SELECT login FROM github_repo_actors WHERE workspace_id=?')
      .all(WORKSPACE_ID);
    expect(actors).toEqual([]);
    // The owner itself is never looked up, and neither is counted as untraceable.
    expect(github.calls.some((call) => call.endpoint === '/users/LemonCrow-Lab')).toBe(false);
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      forksCursor: '2026-10-05T12:00:00.000Z',
      starsCursor: '2026-10-05T09:30:00.000Z',
      lastSummary: { forks: 0, created: 0, attached: 0, unresolved: 0 }
    });
  });

  it("defers, rather than admits, an event while the owner's website cannot be read", async () => {
    let ownerDown = true;
    const routes = lemoncrowRoutes({
      [REPO_PATH]: () => ok({ stargazers_count: 2, forks_count: 0 }),
      [`${REPO_PATH}/stargazers`]: () =>
        ok([star('crow-ops', '2026-10-05T09:00:00Z'), star('sam', '2026-10-05T10:00:00Z')]),
      [`${REPO_PATH}/forks`]: () => ok([]),
      [`${REPO_PATH}/issues`]: () => ok([]),
      // A teammate with only the owner's website domain to go on.
      '/users/crow-ops': () =>
        ok({ ...user('crow-ops'), company: 'LemonCrow', email: 'ops@lemoncrow.dev', blog: null }),
      '/orgs/lemoncrow-lab': () =>
        ownerDown
          ? { status: 502, data: { message: 'Bad Gateway' }, headers: {} }
          : ok({ login: 'lemoncrow-lab', name: 'LemonCrow', blog: 'https://lemoncrow.dev' })
    });
    // Failing open would have made the teammate a lead. Nothing is written,
    // the cursor stays put, and the held events are named on the repository.
    for (const hour of [0, 1]) {
      await poll(fakeGitHub(routes), new Date(T0.getTime() + hour * HOUR));
      expect(await accountByDomain(WORKSPACE_ID, 'lemoncrow.dev')).toBeUndefined();
      expect(await accountByDomain(WORKSPACE_ID, 'newco.dev')).toBeUndefined();
      expect(await repoRow()).toMatchObject({
        status: 'error',
        lastError: OWNER_UNREADABLE_ERROR,
        starsCursor: null,
        nextPollAt: new Date(
          T0.getTime() + hour * HOUR + ERROR_RETRY_MINUTES * 60_000
        ).toISOString(),
        lastSummary: { stars: 0, created: 0, deferred: 2 }
      });
    }

    ownerDown = false;
    await poll(fakeGitHub(routes), new Date(T0.getTime() + 2 * HOUR));
    expect(await accountByDomain(WORKSPACE_ID, 'lemoncrow.dev')).toBeUndefined();
    expect(await accountByDomain(WORKSPACE_ID, 'newco.dev')).toMatchObject({ source: 'github' });
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: '2026-10-05T10:00:00.000Z',
      lastSummary: { stars: 2, created: 1, deferred: 0 }
    });
  });

  it('stops at the rate limit when the owner read is the call that hits it', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        // The only event is the last listing's last one, so no later call
        // could trip the client's rate-limit latch instead.
        [REPO_PATH]: () => ok({ stargazers_count: 0, forks_count: 0 }),
        [`${REPO_PATH}/stargazers`]: () => ok([]),
        [`${REPO_PATH}/forks`]: () => ok([]),
        [`${REPO_PATH}/issues`]: () =>
          ok([
            {
              number: 9,
              html_url: `https://github.com/${REPO}/issues/9`,
              created_at: '2026-10-05T13:20:00Z',
              author_association: 'NONE',
              user: user('sam')
            }
          ]),
        '/orgs/lemoncrow-lab': () => ({
          status: 403,
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH) }
        })
      })
    );
    const result = await poll(github);
    const resetAt = new Date(RESET_EPOCH * 1000).toISOString();
    expect(github.calls.at(-1)?.endpoint).toBe('/orgs/lemoncrow-lab');
    expect(result.rateLimitedUntil).toBe(resetAt);
    expect(await repoRow()).toMatchObject({
      status: 'rate_limited',
      lastError: null,
      rateLimitedUntil: resetAt,
      issuesCursor: null
    });
    expect(await accountByDomain(WORKSPACE_ID, 'newco.dev')).toBeUndefined();
  });

  it('marks the connection for reconnecting when GitHub rejects the token', async () => {
    const github = fakeGitHub({
      [REPO_PATH]: () => ({ status: 401, data: { message: 'Bad credentials' }, headers: {} })
    });
    const result = await poll(github);
    expect(result.connection).toBe('needs_reauth');
    const connection = await db
      .prepare('SELECT status, last_error FROM connections WHERE workspace_id=?')
      .get<{ status: string; last_error: string | null }>(WORKSPACE_ID);
    expect(connection?.status).toBe('needs_reauth');
    expect(connection?.last_error).toContain('Reconnect GitHub');
    expect(await repoRow()).toMatchObject({ status: 'needs_reauth', lastSummary: null });
    const signals = await db
      .prepare('SELECT COUNT(*)::int AS count FROM account_signals WHERE workspace_id=?')
      .get<{ count: number }>(WORKSPACE_ID);
    expect(signals?.count).toBe(0);
  });

  it('does not touch GitHub when the workspace has no GitHub connection', async () => {
    await db.prepare('DELETE FROM connections WHERE workspace_id=?').run(WORKSPACE_ID);
    const github = fakeGitHub(lemoncrowRoutes());
    const result = await poll(github);
    expect(result.connection).toBe('not_connected');
    expect(github.calls).toEqual([]);
    expect(await repoRow()).toMatchObject({ status: 'not_connected', lastSummary: null });
  });

  it('reports a repository GitHub cannot find as not found', async () => {
    await poll(fakeGitHub({}));
    expect(await repoRow()).toMatchObject({
      status: 'not_found',
      nextPollAt: new Date(T0.getTime() + NOT_FOUND_RETRY_HOURS * HOUR).toISOString()
    });
  });

  it('keeps each workspace to its own accounts when two workspaces watch the same repository', async () => {
    await connectGitHub(OTHER_WORKSPACE_ID);
    await watchRepository(
      db,
      { workspaceId: OTHER_WORKSPACE_ID, actorUserId: null, fullName: REPO },
      new Date(T0.getTime() - 60_000)
    );
    await poll(fakeGitHub(lemoncrowRoutes()));
    await poll(fakeGitHub(lemoncrowRoutes()), T0, OTHER_WORKSPACE_ID);

    const mine = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    const theirs = await accountByDomain(OTHER_WORKSPACE_ID, 'buyer.io');
    expect(mine).toMatchObject({ source: 'csv' });
    expect(theirs).toMatchObject({ source: 'github', name: 'Buyer Co' });
    expect(theirs!.id).not.toBe(mine!.id);
    expect(await signalRows(WORKSPACE_ID, mine!.id)).toHaveLength(2);
    const theirActors = await db
      .prepare('SELECT account_id FROM github_repo_actors WHERE workspace_id=?')
      .all<{ account_id: string }>(OTHER_WORKSPACE_ID);
    expect(theirActors.length).toBeGreaterThan(0);
    expect(theirActors.every((row) => row.account_id !== mine!.id)).toBe(true);
  });

  it('reads at most MAX_STAR_PAGES pages of new stars and says so when a burst is larger', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () => ok({ stargazers_count: (MAX_STAR_PAGES + 2) * 100, forks_count: 0 }),
        [`${REPO_PATH}/stargazers`]: (call) => {
          const page = Number(call.params.page);
          return ok(
            Array.from({ length: 100 }, (_, index) =>
              star(
                `bot-${page}-${index}`,
                new Date(
                  Date.parse('2026-10-01T00:00:00Z') + (page * 100 + index) * 60_000
                ).toISOString(),
                'Bot'
              )
            )
          );
        }
      })
    );
    await poll(github);
    const pages = github.calls
      .filter((call) => call.endpoint.endsWith('/stargazers'))
      .map((call) => call.params.page);
    expect(pages).toEqual([5, 4, 3]);
    expect((await repoRow()).lastSummary).toMatchObject({ burstTruncated: true, stars: 0 });
  });

  it('surfaces a company that starred, forked and opened an issue as a high-priority account in Today', async () => {
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/forks`]: () =>
            ok([{ created_at: '2026-10-05T12:00:00Z', owner: user('buyerco', 'Organization') }]),
          '/users/buyerco': () =>
            ok({
              ...user('buyerco', 'Organization'),
              name: 'Buyer Co',
              blog: 'https://www.buyer.io'
            })
        })
      )
    );
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    const score = await db
      .prepare(
        'SELECT tier, distinct_kinds FROM account_scores WHERE workspace_id=? AND account_id=?'
      )
      .get<{ tier: string; distinct_kinds: number }>(WORKSPACE_ID, buyer!.id);
    expect(score).toEqual({ tier: 'hot', distinct_kinds: 3 });

    const today = await getToday(db, WORKSPACE_ID, T0);
    expect(today.needsAttention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'high_priority_account',
          reference: { type: 'account', id: buyer!.id }
        })
      ])
    );
  });

  it('keeps walking back when the computed last stargazer page is empty', async () => {
    // stargazers_count can overstate the list: page 2 is empty, the stars are on page 1.
    const github = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () => ok({ stargazers_count: 200, forks_count: 1 }, { etag: '"repo-v1"' }),
        [`${REPO_PATH}/stargazers`]: (call) =>
          Number(call.params.page) === 2
            ? ok([])
            : ok([star('maya', '2026-10-05T09:00:00Z'), star('sam', '2026-10-05T10:00:00Z')])
      })
    );
    await poll(github);
    const pages = github.calls
      .filter((call) => call.endpoint.endsWith('/stargazers'))
      .map((call) => call.params.page);
    expect(pages).toEqual([2, 1]);
    expect(await repoRow()).toMatchObject({
      starsCursor: '2026-10-05T10:00:00.000Z',
      lastSummary: { stars: 2, burstTruncated: false }
    });
  });

  it('says a fork burst was truncated when a full raw page of forks is all newer than the cursor, bots included', async () => {
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/forks`]: () =>
            ok(
              Array.from({ length: 100 }, (_, index) => ({
                created_at: new Date(
                  Date.parse('2026-10-05T00:00:00Z') - index * 60_000
                ).toISOString(),
                owner: user(`fork-bot-${index}`, 'Bot')
              }))
            )
        })
      )
    );
    expect((await repoRow()).lastSummary).toMatchObject({ forks: 0, burstTruncated: true });
  });

  it('says an issue burst was truncated when a full raw page of issues is all newer than the cursor, bots included', async () => {
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/issues`]: () => ok(botIssues(100, null))
        })
      )
    );
    expect((await repoRow()).lastSummary).toMatchObject({ issues: 0, burstTruncated: true });
  });

  it('does not call a full issue page truncated when its oldest row already reaches the cursor', async () => {
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          [`${REPO_PATH}/issues`]: () => ok(botIssues(100, '2026-07-01T00:00:00Z'))
        })
      )
    );
    expect((await repoRow()).lastSummary).toMatchObject({ issues: 0, burstTruncated: false });
  });

  it('does not count an account another writer inserted first as created', async () => {
    const routes = lemoncrowRoutes({
      [REPO_PATH]: () => ok({ stargazers_count: 1, forks_count: 0 }),
      [`${REPO_PATH}/stargazers`]: () => ok([star('sam', '2026-10-05T10:00:00Z')]),
      [`${REPO_PATH}/forks`]: () => ok([]),
      [`${REPO_PATH}/issues`]: () => ok([])
    });
    const base = fakeGitHub(routes);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let competitor: Promise<void> | null = null;
    let sawBlockedInsert = false;

    // Waits until the poller's own INSERT is blocked on the competitor's
    // uncommitted row, then lets the competitor commit: a real race, not a guess.
    const releaseWhenPollerBlocks = async (): Promise<void> => {
      for (let attempt = 0; attempt < 250 && !sawBlockedInsert; attempt += 1) {
        const waiting = await db
          .prepare(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query ILIKE '%INSERT INTO accounts%ON CONFLICT (workspace_id, LOWER(domain)) DO NOTHING%'`
          )
          .get<{ count: number }>();
        if ((waiting?.count ?? 0) > 0) sawBlockedInsert = true;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
    };

    const racing: GitHubTransport = {
      async get(endpoint, request) {
        if (endpoint === '/users/sam' && !competitor) {
          let inserted!: () => void;
          const insertedRow = new Promise<void>((resolve) => {
            inserted = resolve;
          });
          competitor = db.transaction(async (tx) => {
            await tx
              .prepare(
                `INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, created_at, updated_at)
                 VALUES (?,?,?,?,'manual',?::text[],'active',?,?)`
              )
              .run(
                id('acc'),
                WORKSPACE_ID,
                'NewCo',
                'newco.dev',
                [],
                new Date(T0.getTime() - 60_000).toISOString(),
                T0.toISOString()
              );
            inserted();
            await released;
          });
          await insertedRow;
          void releaseWhenPollerBlocks();
        }
        return base.get(endpoint, request);
      }
    };

    await poll(racing);
    await competitor;
    expect(sawBlockedInsert).toBe(true);
    expect((await repoRow()).lastSummary).toMatchObject({ stars: 1, created: 0, attached: 1 });
    const newco = await accountByDomain(WORKSPACE_ID, 'newco.dev');
    expect(newco).toMatchObject({ source: 'manual', name: 'NewCo' });
    expect((await signalRows(WORKSPACE_ID, newco!.id)).map((row) => row.kind)).toEqual([
      'repo-starred'
    ]);
  });

  it('stops calling GitHub once the run is over its time budget and leaves the other repositories due', async () => {
    const OTHER_PATH = '/repos/lemoncrow-lab/other';
    await watchRepository(
      db,
      { workspaceId: WORKSPACE_ID, actorUserId: null, fullName: 'lemoncrow-lab/other' },
      new Date(T0.getTime() - 30_000)
    );
    let elapsed = 0;
    const base = lemoncrowRoutes();
    const github = fakeGitHub({
      ...base,
      [`${REPO_PATH}/issues`]: (call) => {
        // The first repository's last read: from here on the run is over budget.
        elapsed = GITHUB_POLL_BUDGET_MS + 1;
        return base[`${REPO_PATH}/issues`](call);
      }
    });
    const result = await pollWorkspaceRepositories(db, WORKSPACE_ID, {
      transport: github,
      now: T0,
      clock: () => elapsed
    });

    expect(result.polled).toBe(1);
    expect(result.deferredRepositories).toBe(1);
    expect(github.calls.some((call) => call.endpoint.startsWith(OTHER_PATH))).toBe(false);
    const [first, other] = await listWatchedRepositories(db, WORKSPACE_ID);
    expect(first).toMatchObject({ fullName: REPO, status: 'ok' });
    expect(other).toMatchObject({ fullName: 'lemoncrow-lab/other', status: 'pending' });
    // Lease released and still due: the next automation tick picks it up.
    expect(await hasDueRepositories(db, WORKSPACE_ID, T0)).toBe(true);
  });

  it('defers the rest of a repository when the time budget runs out mid-run', async () => {
    let elapsed = 0;
    const base = lemoncrowRoutes();
    const github = fakeGitHub({
      ...base,
      [`${REPO_PATH}/stargazers`]: (call) => {
        elapsed = GITHUB_POLL_BUDGET_MS + 1;
        return base[`${REPO_PATH}/stargazers`](call);
      }
    });
    await pollWorkspaceRepositories(db, WORKSPACE_ID, {
      transport: github,
      now: T0,
      clock: () => elapsed
    });
    expect(github.calls.map((call) => call.endpoint)).toEqual([
      REPO_PATH,
      `${REPO_PATH}/stargazers`
    ]);
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: null,
      repoEtag: null,
      nextPollAt: new Date(T0.getTime() + 10 * 60_000).toISOString(),
      lastSummary: { stars: 0, deferred: 3 }
    });
    // Not straight back on the next tick: a fresh run would reset the per-run caps.
    expect(await hasDueRepositories(db, WORKSPACE_ID, T0)).toBe(false);
    expect(await hasDueRepositories(db, WORKSPACE_ID, new Date(T0.getTime() + 10 * 60_000))).toBe(
      true
    );
  });

  it('comes back BUDGET_DEFERRAL_MINUTES later when only the time budget deferred the run', async () => {
    expect(BUDGET_DEFERRAL_MINUTES).toBe(10);
    const { routes } = burstOfPeople(3);
    let elapsed = 0;
    const github = fakeGitHub({
      ...routes,
      [`${REPO_PATH}/forks`]: (call) => {
        elapsed = GITHUB_POLL_BUDGET_MS + 1;
        return routes[`${REPO_PATH}/forks`](call);
      }
    });
    await pollWorkspaceRepositories(db, WORKSPACE_ID, {
      transport: github,
      now: T0,
      clock: () => elapsed
    });
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastSummary: { stars: 3, created: 3 },
      nextPollAt: new Date(T0.getTime() + 10 * 60_000).toISOString()
    });
  });

  it('creates at most MAX_NEW_ACCOUNTS_PER_RUN accounts across back-to-back budget-deferred runs', async () => {
    const { routes } = burstOfPeople(MAX_NEW_ACCOUNTS_PER_RUN + 2);
    /** Over budget from the moment `trip`'s profile is read. */
    const tripping = (trip: string) => {
      let elapsed = 0;
      const transport = fakeGitHub({
        ...routes,
        [`/users/${trip}`]: (call) => {
          elapsed = GITHUB_POLL_BUDGET_MS + 1;
          return routes[`/users/${trip}`](call);
        }
      });
      return { transport, clock: () => elapsed };
    };

    // Run 1: person1-4 created, then the budget defers the rest. No cap was hit.
    await pollWorkspaceRepositories(db, WORKSPACE_ID, { now: T0, ...tripping('person4') });
    expect(await githubAccountCount()).toBe(4);
    const second = new Date((await repoRow()).nextPollAt);
    expect(second.getTime()).toBe(T0.getTime() + 10 * 60_000);

    // Run 2, ten minutes later: a fresh run, but the hour already holds 4 new accounts.
    await pollWorkspaceRepositories(db, WORKSPACE_ID, { now: second, ...tripping('person6') });
    expect(await githubAccountCount()).toBe(MAX_NEW_ACCOUNTS_PER_RUN);
    // The cap was reached in this run: back in an hour, not in ten minutes.
    expect((await repoRow()).nextPollAt).toBe(
      new Date(second.getTime() + POLL_INTERVAL_MINUTES * 60_000).toISOString()
    );
  });

  it('records an unexpected failure on the repository and releases its lease', async () => {
    const github: GitHubTransport = {
      async get() {
        throw new Error('socket hang up');
      }
    };
    const result = await poll(github);
    expect(result.polled).toBe(0);
    expect(await repoRow()).toMatchObject({
      status: 'error',
      lastError: 'GitHub could not be reached',
      nextPollAt: new Date(T0.getTime() + ERROR_RETRY_MINUTES * 60_000).toISOString()
    });
    const lease = await db
      .prepare('SELECT lease_until FROM watched_repositories WHERE workspace_id=?')
      .get<{ lease_until: string | null }>(WORKSPACE_ID);
    expect(lease?.lease_until).toBeNull();
  });

  it('stores only a fixed, content-free reason when a check fails', async () => {
    const offline: GitHubTransport = {
      async get() {
        throw new Error('connect ECONNREFUSED 10.0.0.1:3003');
      }
    };
    await poll(offline);
    const failed = await repoRow();
    expect(failed.lastError).toBe('GitHub could not be reached');
    expect(failed.lastError).not.toContain('10.0.0.1');
    expect(failed.lastError).not.toContain('ECONNREFUSED');

    // A GitHub answer keeps its status code, never the path (and login) it was for.
    await poll(
      fakeGitHub(
        lemoncrowRoutes({
          '/users/maya': () => ({ status: 500, data: { message: 'boom' }, headers: {} })
        })
      ),
      new Date(T0.getTime() + 2 * HOUR)
    );
    const answered = await repoRow();
    expect(answered).toMatchObject({ status: 'error', lastError: 'GitHub request failed (500)' });
    expect(answered.lastError).not.toContain('maya');
  });

  it('gives up on a GitHub call that never answers and defers the rest instead of failing', async () => {
    let elapsed = 0;
    const base = lemoncrowRoutes({
      // From here on 30 ms of the run's budget is left.
      [`${REPO_PATH}/stargazers`]: (call) => {
        elapsed = GITHUB_POLL_BUDGET_MS - 30;
        return lemoncrowRoutes()[`${REPO_PATH}/stargazers`](call);
      }
    });
    const answers = fakeGitHub(base);
    const hanging: GitHubTransport = {
      get(endpoint, request) {
        if (endpoint.endsWith('/forks')) return new Promise<GitHubResponse>(() => undefined);
        return answers.get(endpoint, request);
      }
    };
    const result = await pollWorkspaceRepositories(db, WORKSPACE_ID, {
      transport: hanging,
      now: T0,
      clock: () => elapsed
    });
    expect(result.deferredRepositories).toBe(0);
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: '2026-10-05T11:00:00.000Z',
      forksCursor: null,
      nextPollAt: new Date(T0.getTime() + BUDGET_DEFERRAL_MINUTES * 60_000).toISOString(),
      lastSummary: { stars: 3, created: 1 }
    });
  });

  it('locks a remembered company before writing to it, so a concurrent rejection wins', async () => {
    await poll(fakeGitHub(lemoncrowRoutes()));
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toHaveLength(2);

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let competitor: Promise<void> | null = null;
    let sawBlockedLock = false;
    const releaseWhenPollerBlocks = async (): Promise<void> => {
      for (let attempt = 0; attempt < 50 && !sawBlockedLock; attempt += 1) {
        const waiting = await db
          .prepare(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query ILIKE '%SELECT status FROM accounts%FOR UPDATE%'`
          )
          .get<{ count: number }>();
        if ((waiting?.count ?? 0) > 0) sawBlockedLock = true;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
    };
    const base = fakeGitHub(
      lemoncrowRoutes({
        [`${REPO_PATH}/issues`]: () =>
          ok([
            {
              number: 11,
              html_url: `https://github.com/${REPO}/issues/11`,
              created_at: '2026-10-06T13:00:00Z',
              author_association: 'NONE',
              user: user('maya')
            }
          ])
      })
    );
    // The founder rejects buyer.io while the poll is about to write to it.
    const racing: GitHubTransport = {
      async get(endpoint, request) {
        if (endpoint === `${REPO_PATH}/issues` && !competitor) {
          let updated!: () => void;
          const updatedRow = new Promise<void>((resolve) => {
            updated = resolve;
          });
          competitor = db.transaction(async (tx) => {
            await tx
              .prepare("UPDATE accounts SET status='not_a_fit' WHERE workspace_id=? AND id=?")
              .run(WORKSPACE_ID, buyer!.id);
            updated();
            await released;
          });
          await updatedRow;
          void releaseWhenPollerBlocks();
        }
        return base.get(endpoint, request);
      }
    };
    await poll(racing, new Date(T0.getTime() + 2 * HOUR));
    await competitor;
    expect(sawBlockedLock).toBe(true);
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toHaveLength(2);
    expect((await repoRow()).lastSummary).toMatchObject({
      issues: 1,
      ignoredRejected: 1,
      attached: 0
    });
  });

  it('counts the events a spent budget interrupted inside a profile lookup as deferred', async () => {
    let elapsed = 0;
    const base = lemoncrowRoutes();
    const github = fakeGitHub({
      ...base,
      // Maya is the first lookup; her org lookup would be the next GitHub call.
      '/users/maya': (call) => {
        elapsed = GITHUB_POLL_BUDGET_MS + 1;
        return base['/users/maya'](call);
      }
    });
    const result = await pollWorkspaceRepositories(db, WORKSPACE_ID, {
      transport: github,
      now: T0,
      clock: () => elapsed
    });
    expect(result.deferredRepositories).toBe(0);
    expect(github.calls.map((call) => call.endpoint)).toEqual([
      REPO_PATH,
      `${REPO_PATH}/stargazers`,
      '/users/maya'
    ]);
    // maya (interrupted), sam and lee: none processed, so the cursor has not passed them.
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      starsCursor: null,
      nextPollAt: new Date(T0.getTime() + 10 * 60_000).toISOString(),
      lastSummary: { stars: 0, deferred: 3 }
    });
    const buyer = await accountByDomain(WORKSPACE_ID, 'buyer.io');
    expect(await signalRows(WORKSPACE_ID, buyer!.id)).toEqual([]);
  });

  it('defers every other repository to the reset time when the rate limit stops the first one', async () => {
    const otherPath = await watchOther();
    const github = fakeGitHub(
      lemoncrowRoutes({
        '/users/sam': () => ({
          status: 403,
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH) }
        }),
        [otherPath]: () => ok({ stargazers_count: 0, forks_count: 0 })
      })
    );
    const result = await poll(github);
    const resetAt = new Date(RESET_EPOCH * 1000).toISOString();
    expect(result.rateLimitedUntil).toBe(resetAt);
    expect(github.calls.some((call) => call.endpoint.startsWith(otherPath))).toBe(false);
    const [first, other] = await listWatchedRepositories(db, WORKSPACE_ID);
    // sam (interrupted) and lee are still ahead of the cursor.
    expect(first).toMatchObject({
      status: 'rate_limited',
      starsCursor: '2026-10-05T09:00:00.000Z',
      lastSummary: { stars: 1, deferred: 2 }
    });
    expect(other).toMatchObject({
      fullName: 'lemoncrow-lab/other',
      status: 'rate_limited',
      lastError: null,
      rateLimitedUntil: resetAt,
      nextPollAt: resetAt,
      lastPolledAt: null,
      lastSummary: null
    });
  });

  it('marks every other repository for reconnecting, and flips and notifies once, when the token is revoked', async () => {
    const otherPath = await watchOther();
    const github = fakeGitHub({
      [REPO_PATH]: () => ({ status: 401, data: { message: 'Bad credentials' }, headers: {} }),
      [otherPath]: () => ({ status: 401, data: { message: 'Bad credentials' }, headers: {} })
    });
    const result = await poll(github);
    expect(result.connection).toBe('needs_reauth');
    expect(github.calls.map((call) => call.endpoint)).toEqual([REPO_PATH]);
    const [first, other] = await listWatchedRepositories(db, WORKSPACE_ID);
    expect(first).toMatchObject({ status: 'needs_reauth', lastError: null });
    expect(other).toMatchObject({
      fullName: 'lemoncrow-lab/other',
      status: 'needs_reauth',
      lastError: null,
      lastSummary: null
    });
    const connection = await db
      .prepare('SELECT status FROM connections WHERE workspace_id=?')
      .get<{ status: string }>(WORKSPACE_ID);
    expect(connection?.status).toBe('needs_reauth');
    expect(notificationMock.notifyIntegrationNeedsReauth).toHaveBeenCalledTimes(1);
  });

  it('skips the star listing of a repository too large to list, and still reads forks and issues', async () => {
    const github = fakeGitHub(
      lemoncrowRoutes({
        [REPO_PATH]: () =>
          ok({ stargazers_count: MAX_STARGAZERS_LISTABLE + 1, forks_count: 1 }, { etag: '"big"' })
      })
    );
    await poll(github);
    expect(github.calls.some((call) => call.endpoint.endsWith('/stargazers'))).toBe(false);
    expect(github.calls.some((call) => call.endpoint.endsWith('/forks'))).toBe(true);
    expect(await repoRow()).toMatchObject({
      status: 'ok',
      lastError: null,
      starsCursor: null,
      repoEtag: '"big"',
      lastSummary: { stars: 0, forks: 1, issues: 1, burstTruncated: false }
    });
  });

  it('releases the lease even when recording a failure itself fails', async () => {
    const github: GitHubTransport = {
      async get() {
        throw new Error('socket hang up');
      }
    };
    await expect(
      pollWorkspaceRepositories(failFirstStatusWrite(db), WORKSPACE_ID, {
        transport: github,
        now: T0
      })
    ).rejects.toThrow('database went away');
    const lease = await db
      .prepare('SELECT lease_until FROM watched_repositories WHERE workspace_id=?')
      .get<{ lease_until: string | null }>(WORKSPACE_ID);
    expect(lease?.lease_until).toBeNull();
  });
});

/** `count` new stargazers, each with a company email of their own and nothing else. */
function burstOfPeople(count: number): { routes: Record<string, Handler> } {
  const people = Array.from({ length: count }, (_, index) => `person${index + 1}`);
  const routes = lemoncrowRoutes({
    [REPO_PATH]: () => ok({ stargazers_count: people.length, forks_count: 0 }),
    [`${REPO_PATH}/stargazers`]: () =>
      ok(people.map((login, index) => star(login, `2026-10-05T0${index + 1}:00:00Z`))),
    [`${REPO_PATH}/forks`]: () => ok([]),
    [`${REPO_PATH}/issues`]: () => ok([])
  });
  people.forEach((login, index) => {
    routes[`/users/${login}`] = () =>
      ok({ ...user(login), email: `${login}@company${index + 1}.dev`, company: null, blog: null });
  });
  return { routes };
}

async function githubAccountCount(): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*)::int AS count FROM accounts WHERE workspace_id=? AND source='github'")
    .get<{ count: number }>(WORKSPACE_ID);
  return row?.count ?? 0;
}

/** A second watched repository, claimed after the first. Returns its API path. */
async function watchOther(): Promise<string> {
  await watchRepository(
    db,
    { workspaceId: WORKSPACE_ID, actorUserId: null, fullName: 'lemoncrow-lab/other' },
    new Date(T0.getTime() - 30_000)
  );
  return '/repos/lemoncrow-lab/other';
}

/** `db`, except the first repository write that sets a status fails once. */
function failFirstStatusWrite(real: Db): Db {
  let failed = false;
  const wrapper = Object.create(real) as Db;
  wrapper.prepare = (sql: string) => {
    const statement = real.prepare(sql);
    if (failed || !sql.startsWith('UPDATE watched_repositories SET') || !sql.includes('status=')) {
      return statement;
    }
    return {
      ...statement,
      run: async () => {
        failed = true;
        throw new Error('database went away');
      }
    };
  };
  return wrapper;
}

function botIssues(count: number, oldestAt: string | null) {
  return Array.from({ length: count }, (_, index) => ({
    number: 1000 - index,
    html_url: `https://github.com/${REPO}/issues/${1000 - index}`,
    created_at:
      oldestAt && index === count - 1
        ? oldestAt
        : new Date(Date.parse('2026-10-05T20:00:00Z') - index * 60_000).toISOString(),
    author_association: 'NONE',
    user: user(`issue-bot-${index}`, 'Bot')
  }));
}
