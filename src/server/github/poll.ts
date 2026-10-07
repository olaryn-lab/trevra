import { id, type Db } from '../db.js';
import { DEFAULT_WINDOW_DAYS, rescoreAccounts } from '../accounts/score.js';
import { createAccount, rejectedSignalShapes } from '../accounts/store.js';
import { recordSignals, type IncomingSignal } from '../accounts/sweep.js';
import {
  MAX_WATCHED_REPOSITORIES,
  claimDueRepositories,
  emptyPollSummary,
  markConnectionNeedsReauth,
  readGitHubConnection,
  updateRepository,
  type GitHubConnection,
  type GitHubConnectionState,
  type PollSummary,
  type RepositoryPatch,
  type WatchedRepository
} from './repos.js';
import { resolveGitHubActor, type DomainCandidate, type ResolvedActor } from './resolve.js';
import {
  GITHUB_STAR_ACCEPT,
  GitHubClient,
  GitHubConnectionRevokedError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  nangoGitHubTransport,
  type GitHubTransport
} from './transport.js';

/**
 * GitHub repository traction: who starred, forked or opened an issue on the
 * founder's own public repositories, resolved to companies from public data,
 * written as account signals and rescored in the same run.
 *
 * lc-debt: polling through the Nango proxy, at most hourly per repository and
 * inside the shared automation cycle; upgrade path is GitHub App webhooks
 * (`star`, `fork`, `issues`) through Nango's `github-app` provider, deduped by
 * `webhook_events`, which makes every read below unnecessary.
 */

export const POLL_INTERVAL_MINUTES = 60;
export const NOT_CONNECTED_RETRY_MINUTES = 15;
export const NOT_FOUND_RETRY_HOURS = 24;
export const ERROR_RETRY_MINUTES = 60;
/** A first poll reaches back exactly as far as the scorer counts. */
export const BACKFILL_DAYS = DEFAULT_WINDOW_DAYS;
/**
 * lc-debt: at most 300 new stars are read between two polls, and WHICH pages
 * are read relies on GitHub returning stargazers oldest-first (undocumented);
 * a bigger burst keeps the newest 300 and says so (`burstTruncated`); upgrade
 * path is the `star` webhook, or a page cursor carried across runs.
 */
export const MAX_STAR_PAGES = 3;
/**
 * GitHub is believed to refuse stargazer pages past 400 (100 per page), so a
 * repository with more stars than this cannot reach its newest page and its
 * star listing is skipped; forks and issues still run.
 *
 * lc-debt: the newest stars of very large repositories are beyond the REST
 * listable range; upgrade path is GraphQL `stargazers(orderBy: {field:
 * STARRED_AT, direction: DESC})`.
 */
export const MAX_STARGAZERS_LISTABLE = 40_000;
/** Distinct GitHub people looked up per workspace run. Remembered people cost nothing. */
export const MAX_PROFILE_LOOKUPS_PER_RUN = 40;
/**
 * New accounts one run may create. A popular repository must not turn into a
 * thousand-row account list overnight; what is left waits for the next run.
 */
export const MAX_NEW_ACCOUNTS_PER_RUN = 5;
export const MAX_REPOSITORIES_PER_RUN = MAX_WATCHED_REPOSITORIES;
/** Tag on every account this module creates, so the founder can find and review them. */
export const GITHUB_ACCOUNT_TAG = 'github-traction';
/**
 * Wall-clock budget for one workspace run. Under half the default 45 s
 * automation tick budget (`TREVRA_AUTOMATION_BUDGET_MS`), far under
 * POLL_LEASE_MINUTES. Past it no new GitHub call is made; what is left stays
 * due for the next tick.
 */
export const GITHUB_POLL_BUDGET_MS = 20_000;

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
/** Issue authors who are the repository's own team. Their issues are not demand. */
const INSIDER_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface PollDeps {
  transport?: GitHubTransport;
  now?: Date;
  /** Milliseconds, for the run's elapsed time only. Default `Date.now`. */
  clock?: () => number;
}

export interface PollOptions {
  maxRepositories?: number;
}

export interface WorkspacePollResult {
  connection: GitHubConnectionState;
  polled: number;
  accountIds: string[];
  rateLimitedUntil: string | null;
  /** Repositories claimed but not started because the run's time budget was spent; still due. */
  deferredRepositories: number;
}

type TractionKind = 'repo-starred' | 'repo-forked' | 'repo-issue-opened';
type ActorType = 'User' | 'Organization' | 'Bot';

interface TractionEvent {
  kind: TractionKind;
  login: string;
  at: Date;
  issueNumber: number | null;
  issueUrl: string | null;
}

interface Listing {
  events: TractionEvent[];
  /** Newest timestamp among everything read past the cursor, skipped items included. */
  newest: Date | null;
  truncated: boolean;
  etag: string | null;
  notModified: boolean;
}

interface RunState {
  lookups: number;
  created: number;
  touched: Set<string>;
  resolved: Map<string, ResolvedActor | null>;
  overBudget: () => boolean;
}

/** The run's time budget is spent; thrown instead of making a GitHub call. */
class PollBudgetSpentError extends Error {
  constructor() {
    super(`GitHub poll run exceeded ${GITHUB_POLL_BUDGET_MS} ms`);
    this.name = 'PollBudgetSpentError';
  }
}

function budgetedTransport(transport: GitHubTransport, overBudget: () => boolean): GitHubTransport {
  return {
    async get(endpoint, request) {
      if (overBudget()) throw new PollBudgetSpentError();
      return transport.get(endpoint, request);
    }
  };
}

type AttachOutcome =
  | { kind: 'defer' }
  | { kind: 'rejected' }
  | { kind: 'created' | 'attached'; accountId: string; written: number };

function minutesFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** GitHub App accounts end in `[bot]` even when `type` says User. */
function actorTypeOf(value: unknown, login: unknown): ActorType {
  if (value === 'Organization') return 'Organization';
  if (value === 'Bot' || (typeof login === 'string' && login.endsWith('[bot]'))) return 'Bot';
  return 'User';
}

function byTime(left: TractionEvent, right: TractionEvent): number {
  return left.at.getTime() - right.at.getTime() || left.login.localeCompare(right.login);
}

function repoPath(repo: WatchedRepository): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/**
 * Read from the cursor, never further back than the scorer's window.
 *
 * lc-debt: the cursor is a timestamp compared `at <= since` at GitHub's
 * one-second granularity, so two events in the same second split across a
 * deferral (cap, budget, rate limit) lose the second one; upgrade path is a
 * (timestamp, login/number) tie-break cursor.
 */
function sinceFor(cursor: string | null, now: Date): Date {
  const floor = new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  if (!cursor) return floor;
  const at = new Date(cursor);
  return at > floor ? at : floor;
}

function items(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function later(current: Date | null, candidate: Date): Date {
  return current && current >= candidate ? current : candidate;
}

/**
 * New stars, newest pages first. Page SELECTION relies on GitHub returning
 * stargazers oldest-first (undocumented), so the newest stars are on the last
 * page: start there and walk back until a page reaches the cursor. An empty
 * page (stargazers_count can overstate the list) says nothing about the
 * cursor, so the walk goes on to the page before it. Every item is still
 * filtered by `starred_at > cursor`: another order costs completeness, never
 * a duplicate.
 */
async function listNewStars(
  client: GitHubClient,
  repo: WatchedRepository,
  stargazersCount: number,
  since: Date
): Promise<Listing> {
  const listing: Listing = {
    events: [],
    newest: null,
    truncated: false,
    etag: null,
    notModified: false
  };
  if (stargazersCount <= 0 || stargazersCount > MAX_STARGAZERS_LISTABLE) return listing;
  let pagesRead = 0;
  for (let page = Math.ceil(stargazersCount / PAGE_SIZE); page >= 1; page -= 1) {
    if (pagesRead >= MAX_STAR_PAGES) {
      listing.truncated = true;
      break;
    }
    pagesRead += 1;
    const response = await client.get(`${repoPath(repo)}/stargazers`, {
      params: { per_page: PAGE_SIZE, page },
      headers: { Accept: GITHUB_STAR_ACCEPT }
    });
    const rows = items(response.data);
    let reachedCursor = false;
    for (const row of rows) {
      const at = parseTime(row.starred_at);
      const actor = row.user as Record<string, unknown> | undefined;
      if (!at || !actor || typeof actor.login !== 'string') continue;
      if (at <= since) {
        reachedCursor = true;
        continue;
      }
      listing.newest = later(listing.newest, at);
      if (actorTypeOf(actor.type, actor.login) === 'Bot') continue;
      listing.events.push({
        kind: 'repo-starred',
        login: actor.login,
        at,
        issueNumber: null,
        issueUrl: null
      });
    }
    if (reachedCursor) break;
  }
  listing.events.sort(byTime);
  return listing;
}

/**
 * lc-debt: one page (100) of new forks, and of new issues, per run; a bigger
 * burst keeps the newest page and says so (`burstTruncated`, judged on the RAW
 * page so a page of bots still counts); upgrade path is the `fork` and
 * `issues` webhooks.
 */
async function listNewForks(
  client: GitHubClient,
  repo: WatchedRepository,
  since: Date
): Promise<Listing> {
  const listing: Listing = {
    events: [],
    newest: null,
    truncated: false,
    etag: null,
    notModified: false
  };
  const response = await client.get(`${repoPath(repo)}/forks`, {
    params: { sort: 'newest', per_page: PAGE_SIZE }
  });
  const rows = items(response.data);
  let reachedCursor = false;
  for (const row of rows) {
    const at = parseTime(row.created_at);
    if (!at) continue;
    if (at <= since) {
      reachedCursor = true;
      continue;
    }
    listing.newest = later(listing.newest, at);
    const owner = row.owner as Record<string, unknown> | undefined;
    if (!owner || typeof owner.login !== 'string') continue;
    if (actorTypeOf(owner.type, owner.login) === 'Bot') continue;
    listing.events.push({
      kind: 'repo-forked',
      login: owner.login,
      at,
      issueNumber: null,
      issueUrl: null
    });
  }
  listing.truncated = rows.length === PAGE_SIZE && !reachedCursor;
  listing.events.sort(byTime);
  return listing;
}

async function listNewIssues(
  client: GitHubClient,
  repo: WatchedRepository,
  since: Date
): Promise<Listing> {
  const listing: Listing = {
    events: [],
    newest: null,
    truncated: false,
    etag: null,
    notModified: false
  };
  const response = await client.get(`${repoPath(repo)}/issues`, {
    params: {
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: PAGE_SIZE,
      since: since.toISOString()
    },
    headers: repo.issuesEtag ? { 'If-None-Match': repo.issuesEtag } : {}
  });
  if (response.status === 304) {
    return { ...listing, etag: repo.issuesEtag, notModified: true };
  }
  const rows = items(response.data);
  let reachedCursor = false;
  for (const row of rows) {
    const at = parseTime(row.created_at);
    if (!at) continue;
    if (at <= since) {
      reachedCursor = true;
      continue;
    }
    listing.newest = later(listing.newest, at);
    const author = row.user as Record<string, unknown> | undefined;
    if (row.pull_request !== undefined && row.pull_request !== null) continue;
    if (INSIDER_ASSOCIATIONS.has(String(row.author_association))) continue;
    if (!author || typeof author.login !== 'string') continue;
    if (actorTypeOf(author.type, author.login) === 'Bot') continue;
    if (typeof row.number !== 'number' || typeof row.html_url !== 'string') continue;
    listing.events.push({
      kind: 'repo-issue-opened',
      login: author.login,
      at,
      issueNumber: row.number,
      issueUrl: row.html_url
    });
  }
  // Sorted by creation, newest first: a full page that never reached the
  // cursor may have more new issues behind it.
  listing.truncated = rows.length === PAGE_SIZE && !reachedCursor;
  listing.etag = response.headers.etag ?? null;
  listing.events.sort(byTime);
  return listing;
}

/** Content-free detail; the fingerprint input makes the same event one row forever. */
function signalFor(
  repo: WatchedRepository,
  event: TractionEvent,
  profileUrl: string
): IncomingSignal {
  const repoKey = repo.fullName.toLowerCase();
  if (event.kind === 'repo-issue-opened') {
    return {
      kind: event.kind,
      detail: `opened an issue on ${repo.fullName}`,
      previous: null,
      current: `${repoKey}#${event.issueNumber}`,
      evidenceUrl: event.issueUrl ?? profileUrl,
      observedAt: event.at
    };
  }
  return {
    kind: event.kind,
    detail: `${event.kind === 'repo-starred' ? 'starred' : 'forked'} ${repo.fullName}`,
    previous: null,
    current: `${repoKey}@${event.login.toLowerCase()}`,
    evidenceUrl: profileUrl,
    observedAt: event.at
  };
}

function countKind(summary: PollSummary, kind: TractionKind): void {
  if (kind === 'repo-starred') summary.stars += 1;
  else if (kind === 'repo-forked') summary.forks += 1;
  else summary.issues += 1;
}

async function knownActor(
  db: Db,
  workspaceId: string,
  login: string
): Promise<{ id: string; accountId: string; profileUrl: string; status: string } | null> {
  const row = await db
    .prepare(
      `SELECT ga.id, ga.account_id, ga.profile_url, a.status
       FROM github_repo_actors ga
       JOIN accounts a ON a.id = ga.account_id AND a.workspace_id = ga.workspace_id
       WHERE ga.workspace_id=? AND LOWER(ga.login)=LOWER(?)`
    )
    .get<{ id: string; account_id: string; profile_url: string; status: string }>(
      workspaceId,
      login
    );
  return row
    ? { id: row.id, accountId: row.account_id, profileUrl: row.profile_url, status: row.status }
    : null;
}

/**
 * One event, written atomically: the account (found or created), the
 * remembered login and the signal land together or not at all.
 */
async function processEvent(
  db: Db,
  workspaceId: string,
  repo: WatchedRepository,
  event: TractionEvent,
  client: GitHubClient,
  run: RunState,
  summary: PollSummary,
  now: Date
): Promise<'done' | 'defer'> {
  const known = await knownActor(db, workspaceId, event.login);
  if (known) {
    // A rejected or archived company stays exactly as the founder left it.
    if (known.status !== 'active') {
      summary.ignoredRejected += 1;
      return 'done';
    }
    const written = await db.transaction(async (tx) => {
      await tx
        .prepare(
          'UPDATE github_repo_actors SET last_seen_at=?::timestamptz WHERE id=? AND workspace_id=?'
        )
        .run(now.toISOString(), known.id, workspaceId);
      return recordSignals(
        tx,
        workspaceId,
        known.accountId,
        [signalFor(repo, event, known.profileUrl)],
        now
      );
    });
    summary.attached += 1;
    if (written.length > 0) run.touched.add(known.accountId);
    return 'done';
  }

  const key = event.login.toLowerCase();
  let resolved = run.resolved.get(key);
  if (resolved === undefined) {
    // A lookup is a GitHub call: neither the lookup cap nor a spent time
    // budget may be passed. Remembered people above cost nothing.
    if (run.lookups >= MAX_PROFILE_LOOKUPS_PER_RUN || run.overBudget()) return 'defer';
    run.lookups += 1;
    resolved = await resolveGitHubActor(client, event.login);
    run.resolved.set(key, resolved);
  }
  if (!resolved || resolved.candidates.length === 0) {
    summary.unresolved += 1;
    return 'done';
  }
  const actor = resolved;

  const outcome = await db.transaction(async (tx): Promise<AttachOutcome> => {
    let match: { id: string; status: string } | undefined;
    let chosen: DomainCandidate = actor.candidates[0];
    for (const candidate of actor.candidates) {
      match = await tx
        .prepare(
          'SELECT id, status FROM accounts WHERE workspace_id=? AND LOWER(domain)=? FOR UPDATE'
        )
        .get<{ id: string; status: string }>(workspaceId, candidate.domain);
      if (match) {
        chosen = candidate;
        break;
      }
    }
    let created = false;
    if (!match) {
      if (run.created >= MAX_NEW_ACCOUNTS_PER_RUN) return { kind: 'defer' };
      // createAccount is idempotent on the domain and returns an existing row
      // unchanged, so a race can never reactivate a rejected company. It does
      // not say which happened: a row stamped with this run's `now` is ours,
      // anything older lost a race to another writer and is not "created".
      const account = await createAccount(
        tx,
        workspaceId,
        {
          name: chosen.name ?? chosen.domain,
          domain: chosen.domain,
          source: 'github',
          tags: [GITHUB_ACCOUNT_TAG]
        },
        now
      );
      match = { id: account.id, status: account.status };
      created = account.createdAt === now.toISOString();
    }
    if (match.status !== 'active') return { kind: 'rejected' };

    // lc-debt: GitHub actor logins persist until workspace erasure; add a last-seen retention prune in the poller.
    await tx
      .prepare(
        `INSERT INTO github_repo_actors
           (id, workspace_id, login, profile_url, account_id, resolved_domain, resolved_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?::timestamptz,?::timestamptz)
         ON CONFLICT (workspace_id, LOWER(login)) DO UPDATE SET
           account_id=EXCLUDED.account_id, profile_url=EXCLUDED.profile_url,
           resolved_domain=EXCLUDED.resolved_domain, resolved_via=EXCLUDED.resolved_via,
           last_seen_at=EXCLUDED.last_seen_at`
      )
      .run(
        id('ghact'),
        workspaceId,
        actor.login,
        actor.profileUrl,
        match.id,
        chosen.domain,
        chosen.via,
        now.toISOString(),
        now.toISOString()
      );
    const written = await recordSignals(
      tx,
      workspaceId,
      match.id,
      [signalFor(repo, event, actor.profileUrl)],
      now
    );
    return { kind: created ? 'created' : 'attached', accountId: match.id, written: written.length };
  });

  if (outcome.kind === 'defer') return 'defer';
  if (outcome.kind === 'rejected') {
    summary.ignoredRejected += 1;
    return 'done';
  }
  if (outcome.kind === 'created') {
    run.created += 1;
    summary.created += 1;
  } else {
    summary.attached += 1;
  }
  if (outcome.written > 0) run.touched.add(outcome.accountId);
  return 'done';
}

/**
 * Events oldest first. `advance` moves the cursor after each one, so an
 * exception (rate limit, revoked token) keeps everything already written.
 * Returns false when a per-run cap deferred the rest. A spent time budget or
 * a rate limit hit mid-listing counts the unprocessed events (the interrupted
 * one included: its lookup wrote nothing) as `deferred` and rethrows; the
 * cursor never passes them.
 */
async function processListing(
  db: Db,
  workspaceId: string,
  repo: WatchedRepository,
  listing: Listing,
  client: GitHubClient,
  run: RunState,
  summary: PollSummary,
  now: Date,
  advance: (at: Date) => void
): Promise<boolean> {
  for (let index = 0; index < listing.events.length; index += 1) {
    const event = listing.events[index];
    let outcome: 'done' | 'defer';
    try {
      outcome = await processEvent(db, workspaceId, repo, event, client, run, summary, now);
    } catch (error) {
      if (error instanceof PollBudgetSpentError || error instanceof GitHubRateLimitedError) {
        summary.deferred += listing.events.length - index;
      }
      throw error;
    }
    if (outcome === 'defer') {
      summary.deferred += listing.events.length - index;
      return false;
    }
    countKind(summary, event.kind);
    advance(event.at);
  }
  if (listing.newest) advance(listing.newest);
  return true;
}

async function pollRepository(
  db: Db,
  workspaceId: string,
  repo: WatchedRepository,
  client: GitHubClient,
  run: RunState,
  now: Date,
  progress: RepositoryPatch,
  summary: PollSummary
): Promise<void> {
  const meta = await client.get(repoPath(repo), {
    headers: repo.repoEtag ? { 'If-None-Match': repo.repoEtag } : {}
  });
  if (meta.status !== 304) {
    // Until stars and forks are fully processed the old ETag must not survive:
    // a 304 next run would skip whatever this run did not finish.
    progress.repoEtag = null;
    const data = (meta.data ?? {}) as { stargazers_count?: unknown };
    const stargazers = Number(data.stargazers_count ?? 0);
    const stars = await listNewStars(
      client,
      repo,
      Number.isFinite(stargazers) ? stargazers : 0,
      sinceFor(repo.starsCursor, now)
    );
    summary.burstTruncated = stars.truncated;
    const starsDone = await processListing(
      db,
      workspaceId,
      repo,
      stars,
      client,
      run,
      summary,
      now,
      (at) => {
        progress.starsCursor = at;
      }
    );
    const forks = await listNewForks(client, repo, sinceFor(repo.forksCursor, now));
    summary.burstTruncated = summary.burstTruncated || forks.truncated;
    const forksDone = await processListing(
      db,
      workspaceId,
      repo,
      forks,
      client,
      run,
      summary,
      now,
      (at) => {
        progress.forksCursor = at;
      }
    );
    if (starsDone && forksDone) progress.repoEtag = meta.headers.etag ?? null;
  }

  const issues = await listNewIssues(client, repo, sinceFor(repo.issuesCursor, now));
  if (issues.notModified) return;
  summary.burstTruncated = summary.burstTruncated || issues.truncated;
  progress.issuesEtag = null;
  const issuesDone = await processListing(
    db,
    workspaceId,
    repo,
    issues,
    client,
    run,
    summary,
    now,
    (at) => {
      progress.issuesCursor = at;
    }
  );
  if (issuesDone) progress.issuesEtag = issues.etag;
}

/**
 * Poll every due repository of one workspace.
 *
 * NEVER THROWS FOR A GITHUB CONDITION. Not connected, needs reconnecting,
 * rate limited, not found and any other failure are written to the
 * repository row (and, for a revoked token, to the connection row), because
 * the Setup card must show them instead of a quiet zero. Only a database
 * failure escapes; every claimed repository's lease is still released on the
 * way out (best effort), and POLL_LEASE_MINUTES frees whatever that misses.
 *
 * A run stops issuing GitHub calls once it has run GITHUB_POLL_BUDGET_MS:
 * the repository in flight keeps what it wrote and counts the rest as
 * `deferred`; repositories not yet started are released untouched, stay due
 * for the next automation tick, and are counted in `deferredRepositories`.
 */
export async function pollWorkspaceRepositories(
  db: Db,
  workspaceId: string,
  deps: PollDeps = {},
  opts: PollOptions = {}
): Promise<WorkspacePollResult> {
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const overBudget = (): boolean => clock() - startedAt > GITHUB_POLL_BUDGET_MS;
  const connection = await readGitHubConnection(db, workspaceId);
  const result: WorkspacePollResult = {
    connection: connection.state,
    polled: 0,
    accountIds: [],
    rateLimitedUntil: null,
    deferredRepositories: 0
  };
  const repos = await claimDueRepositories(
    db,
    workspaceId,
    now,
    opts.maxRepositories ?? MAX_REPOSITORIES_PER_RUN
  );
  if (repos.length === 0) return result;

  // Every claimed repository is written exactly once through `settle`, which
  // also releases its lease; the `finally` releases any an exception skipped.
  const settled = new Set<string>();
  const settle = async (repoId: string, patch: RepositoryPatch): Promise<void> => {
    await updateRepository(db, workspaceId, repoId, patch, now);
    settled.add(repoId);
  };
  try {
    await pollClaimed(db, workspaceId, repos, connection, deps, now, overBudget, result, settle);
  } finally {
    for (const repo of repos) {
      if (settled.has(repo.id)) continue;
      try {
        await updateRepository(db, workspaceId, repo.id, {}, now);
      } catch {
        // The original failure is what propagates; the lease expires on its own.
      }
    }
  }
  return result;
}

async function pollClaimed(
  db: Db,
  workspaceId: string,
  repos: WatchedRepository[],
  connection: GitHubConnection,
  deps: PollDeps,
  now: Date,
  overBudget: () => boolean,
  result: WorkspacePollResult,
  settle: (repoId: string, patch: RepositoryPatch) => Promise<void>
): Promise<void> {
  if (connection.state !== 'connected' || !connection.externalConnectionId) {
    const status = connection.state === 'needs_reauth' ? 'needs_reauth' : 'not_connected';
    for (const repo of repos) {
      await settle(repo.id, {
        status,
        lastError: null,
        nextPollAt: minutesFrom(now, NOT_CONNECTED_RETRY_MINUTES)
      });
    }
    return;
  }

  let transport: GitHubTransport;
  try {
    transport =
      deps.transport ??
      nangoGitHubTransport({
        providerConfigKey: connection.providerConfigKey,
        connectionId: connection.externalConnectionId
      });
  } catch (error) {
    for (const repo of repos) {
      await settle(repo.id, {
        status: 'error',
        lastError: messageOf(error),
        nextPollAt: minutesFrom(now, ERROR_RETRY_MINUTES)
      });
    }
    return;
  }

  const client = new GitHubClient(budgetedTransport(transport, overBudget), now);
  const run: RunState = {
    lookups: 0,
    created: 0,
    touched: new Set(),
    resolved: new Map(),
    overBudget
  };
  /** Out of time before starting: release untouched, still due next tick. */
  const releaseUntouched = async (rest: WatchedRepository[]): Promise<void> => {
    for (const repo of rest) await settle(repo.id, {});
    result.deferredRepositories += rest.length;
  };

  for (let index = 0; index < repos.length; index += 1) {
    const repo = repos[index];
    if (overBudget()) {
      await releaseUntouched(repos.slice(index));
      break;
    }
    const progress: RepositoryPatch = {};
    const summary = emptyPollSummary();
    try {
      await pollRepository(db, workspaceId, repo, client, run, now, progress, summary);
      await settle(repo.id, {
        ...progress,
        status: 'ok',
        lastError: null,
        rateLimitedUntil: null,
        lastPolledAt: now,
        lastSummary: summary,
        addUnresolved: summary.unresolved,
        nextPollAt: minutesFrom(now, POLL_INTERVAL_MINUTES)
      });
      result.polled += 1;
    } catch (error) {
      if (error instanceof PollBudgetSpentError) {
        // Nothing went wrong: keep what was written and come back next tick.
        await settle(repo.id, {
          ...progress,
          status: 'ok',
          lastError: null,
          rateLimitedUntil: null,
          lastPolledAt: now,
          lastSummary: summary,
          addUnresolved: summary.unresolved,
          nextPollAt: now
        });
        await releaseUntouched(repos.slice(index + 1));
        break;
      }
      if (error instanceof GitHubRateLimitedError) {
        // The client is latched: any further call would refuse without the
        // wire, so every remaining repository is deferred to the reset time.
        result.rateLimitedUntil = error.resetAt.toISOString();
        await settle(repo.id, {
          ...progress,
          status: 'rate_limited',
          lastError: null,
          rateLimitedUntil: error.resetAt,
          nextPollAt: error.resetAt,
          lastPolledAt: now,
          lastSummary: summary,
          addUnresolved: summary.unresolved
        });
        for (const rest of repos.slice(index + 1)) {
          await settle(rest.id, {
            status: 'rate_limited',
            lastError: null,
            rateLimitedUntil: error.resetAt,
            nextPollAt: error.resetAt
          });
        }
        break;
      }
      if (error instanceof GitHubConnectionRevokedError) {
        result.connection = 'needs_reauth';
        if (connection.localConnectionId) {
          await markConnectionNeedsReauth(
            db,
            workspaceId,
            connection.localConnectionId,
            error.message,
            now
          );
        }
        for (const affected of repos.slice(index)) {
          await settle(affected.id, {
            ...(affected.id === repo.id ? { ...progress, addUnresolved: summary.unresolved } : {}),
            status: 'needs_reauth',
            lastError: null,
            nextPollAt: minutesFrom(now, NOT_CONNECTED_RETRY_MINUTES)
          });
        }
        break;
      }
      if (error instanceof GitHubNotFoundError && error.endpoint === repoPath(repo)) {
        await settle(repo.id, {
          status: 'not_found',
          lastError: null,
          lastPolledAt: now,
          nextPollAt: minutesFrom(now, NOT_FOUND_RETRY_HOURS * 60)
        });
        continue;
      }
      await settle(repo.id, {
        ...progress,
        status: 'error',
        lastError: messageOf(error),
        lastPolledAt: now,
        addUnresolved: summary.unresolved,
        nextPollAt: minutesFrom(now, ERROR_RETRY_MINUTES)
      });
    }
  }

  // Scoring follows the writes in the same turn, over the accounts touched.
  result.accountIds = [...run.touched];
  if (result.accountIds.length > 0) {
    const rejectedShapes = await rejectedSignalShapes(db, workspaceId);
    await rescoreAccounts(db, workspaceId, result.accountIds, { rejectedShapes, now });
  }
}
