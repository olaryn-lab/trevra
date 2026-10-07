import { id, type Db } from '../db.js';
import { githubProviderConfigKey } from '../integration-service.js';
import { notifyIntegrationNeedsReauth } from '../notifications.js';

/**
 * Which of the founder's own public GitHub repositories Trevra watches, and
 * the polling bookkeeping that keeps the watch cheap and honest.
 *
 * CHEAP: per-kind cursors so a poll reads only what is new, and ETags so an
 * unchanged repository costs a 304 that GitHub does not count against the
 * rate limit.
 *
 * HONEST: a status the Setup card reads. "Not connected", "needs
 * reconnecting" and "rate limited until 13:00" are states, never a quiet zero.
 *
 * Credentials are not here: the GitHub token lives in Nango.
 */

/**
 * lc-debt: 10 repositories per workspace keeps one poll run to roughly 70
 * GitHub requests plus profile lookups; upgrade path is GitHub App webhooks
 * (see poll.ts), after which the cap only bounds the Setup list.
 */
export const MAX_WATCHED_REPOSITORIES = 10;

/** How long a claimed repository is held before another worker may take it. */
export const POLL_LEASE_MINUTES = 15;

export type WatchedRepositoryStatus =
  'pending' | 'ok' | 'not_found' | 'rate_limited' | 'needs_reauth' | 'not_connected' | 'error';

/** What one poll of one repository found. Counts only: no names, no content. */
export interface PollSummary {
  /** New stars read this run (bots excluded). */
  stars: number;
  forks: number;
  /** New issues opened by people outside the repository's own team. */
  issues: number;
  /** Events attached to an account that already existed. */
  attached: number;
  /** Accounts created from a resolved company domain. */
  created: number;
  /** Events from people no public data ties to a company. Counted, never stored. */
  unresolved: number;
  /** Events from a company the founder marked not a fit or archived. */
  ignoredRejected: number;
  /** Events left for the next run because a per-run cap or the run's time budget was reached. */
  deferred: number;
  /** More new stars, forks or issues arrived than one run reads; the oldest were skipped. */
  burstTruncated: boolean;
}

export function emptyPollSummary(): PollSummary {
  return {
    stars: 0,
    forks: 0,
    issues: 0,
    attached: 0,
    created: 0,
    unresolved: 0,
    ignoredRejected: 0,
    deferred: 0,
    burstTruncated: false
  };
}

export interface WatchedRepository {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  /** `owner/name`, as the founder typed it. */
  fullName: string;
  url: string;
  status: WatchedRepositoryStatus;
  lastError: string | null;
  starsCursor: string | null;
  forksCursor: string | null;
  issuesCursor: string | null;
  repoEtag: string | null;
  issuesEtag: string | null;
  rateLimitedUntil: string | null;
  nextPollAt: string;
  lastPolledAt: string | null;
  lastSummary: PollSummary | null;
  unresolvedTotal: number;
  createdAt: string;
}

export class GitHubRepoError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitHubRepoError';
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;

/** `owner/name`, or a github.com link to the repository (any deeper path is ignored). */
export function parseRepoFullName(raw: string): { owner: string; name: string } | null {
  const trimmed = raw.trim();
  const fromUrl = GITHUB_URL_PREFIX.test(trimmed);
  const path = trimmed.replace(GITHUB_URL_PREFIX, '').split(/[?#]/)[0].replace(/\/+$/, '');
  const parts = fromUrl ? path.split('/').slice(0, 2) : path.split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return null;
  if (name === '.' || name === '..') return null;
  return { owner, name };
}

interface RepoRow {
  id: string;
  workspace_id: string;
  owner: string;
  name: string;
  status: string;
  last_error: string | null;
  stars_cursor: string | Date | null;
  forks_cursor: string | Date | null;
  issues_cursor: string | Date | null;
  repo_etag: string | null;
  issues_etag: string | null;
  rate_limited_until: string | Date | null;
  next_poll_at: string | Date;
  last_polled_at: string | Date | null;
  last_summary_json: Partial<PollSummary> | null;
  unresolved_total: number | string;
  created_at: string | Date;
}

const REPO_COLUMNS = `id, workspace_id, owner, name, status, last_error, stars_cursor, forks_cursor,
  issues_cursor, repo_etag, issues_etag, rate_limited_until, next_poll_at, last_polled_at,
  last_summary_json, unresolved_total, created_at`;

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toRepository(row: RepoRow): WatchedRepository {
  const stored = row.last_summary_json ?? {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    owner: row.owner,
    name: row.name,
    fullName: `${row.owner}/${row.name}`,
    url: `https://github.com/${row.owner}/${row.name}`,
    status: row.status as WatchedRepositoryStatus,
    lastError: row.last_error,
    starsCursor: isoOrNull(row.stars_cursor),
    forksCursor: isoOrNull(row.forks_cursor),
    issuesCursor: isoOrNull(row.issues_cursor),
    repoEtag: row.repo_etag,
    issuesEtag: row.issues_etag,
    rateLimitedUntil: isoOrNull(row.rate_limited_until),
    nextPollAt: new Date(row.next_poll_at).toISOString(),
    lastPolledAt: isoOrNull(row.last_polled_at),
    lastSummary: Object.keys(stored).length > 0 ? { ...emptyPollSummary(), ...stored } : null,
    unresolvedTotal: Number(row.unresolved_total),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function listWatchedRepositories(
  db: Db,
  workspaceId: string
): Promise<WatchedRepository[]> {
  const rows = await db
    .prepare(
      `SELECT ${REPO_COLUMNS} FROM watched_repositories WHERE workspace_id=? ORDER BY created_at ASC, id ASC`
    )
    .all<RepoRow>(workspaceId);
  return rows.map(toRepository);
}

/**
 * Start watching a repository. Idempotent on the name (case-insensitive, as
 * GitHub is): adding one already watched returns it unchanged.
 *
 * The cap check and the insert run under one per-workspace advisory lock, so
 * two simultaneous adds cannot both pass the count and land an eleventh row.
 */
export async function watchRepository(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; fullName: string },
  now: Date = new Date()
): Promise<{ repo: WatchedRepository; created: boolean }> {
  const parsed = parseRepoFullName(input.fullName);
  if (!parsed) {
    throw new GitHubRepoError(
      `'${input.fullName.slice(0, 200)}' is not a GitHub repository. Use owner/name, for example lemoncrow-lab/lemoncrow.`,
      400
    );
  }
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`github-watch\u001f${input.workspaceId}`);
    const existing = await tx
      .prepare(
        `SELECT ${REPO_COLUMNS} FROM watched_repositories
         WHERE workspace_id=? AND LOWER(owner)=LOWER(?) AND LOWER(name)=LOWER(?)`
      )
      .get<RepoRow>(input.workspaceId, parsed.owner, parsed.name);
    if (existing) return { repo: toRepository(existing), created: false };

    const counted = await tx
      .prepare('SELECT COUNT(*)::int AS count FROM watched_repositories WHERE workspace_id=?')
      .get<{ count: number }>(input.workspaceId);
    if ((counted?.count ?? 0) >= MAX_WATCHED_REPOSITORIES) {
      throw new GitHubRepoError(
        `A workspace can watch at most ${MAX_WATCHED_REPOSITORIES} repositories. Remove one first.`,
        409
      );
    }

    const iso = now.toISOString();
    const row = await tx
      .prepare(
        `INSERT INTO watched_repositories
           (id, workspace_id, owner, name, created_by_user_id, status, next_poll_at, created_at, updated_at)
         VALUES (?,?,?,?,?,'pending',?::timestamptz,?::timestamptz,?::timestamptz)
         RETURNING ${REPO_COLUMNS}`
      )
      .get<RepoRow>(
        id('ghrepo'),
        input.workspaceId,
        parsed.owner,
        parsed.name,
        input.actorUserId,
        iso,
        iso,
        iso
      );
    if (!row) throw new Error('Watching the repository returned no row');
    return { repo: toRepository(row), created: true };
  });
}

/** Stop watching. Signals and accounts already written stay: they are evidence. */
export async function unwatchRepository(
  db: Db,
  workspaceId: string,
  repoId: string
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM watched_repositories WHERE workspace_id=? AND id=?')
    .run(workspaceId, repoId);
  return result.changes > 0;
}

export type GitHubConnectionState = 'connected' | 'needs_reauth' | 'not_connected';

export interface GitHubConnection {
  state: GitHubConnectionState;
  localConnectionId: string | null;
  providerConfigKey: string;
  externalConnectionId: string | null;
  lastError: string | null;
}

/**
 * This workspace's GitHub connection, as the poller and the Setup card see it.
 * The connection row decides the workspace; nothing GitHub returns ever does.
 * Demo rows and disconnected rows do not count as a connection.
 */
export async function readGitHubConnection(db: Db, workspaceId: string): Promise<GitHubConnection> {
  const providerConfigKey = githubProviderConfigKey();
  const row = await db
    .prepare(
      `SELECT id, external_connection_id, status, last_error
       FROM connections
       WHERE workspace_id=? AND provider_config_key=? AND is_demo=0 AND status <> 'disconnected'
       ORDER BY (status = 'connected') DESC, updated_at DESC, id DESC
       LIMIT 1`
    )
    .get<{
      id: string;
      external_connection_id: string;
      status: string;
      last_error: string | null;
    }>(workspaceId, providerConfigKey);
  if (!row) {
    return {
      state: 'not_connected',
      localConnectionId: null,
      providerConfigKey,
      externalConnectionId: null,
      lastError: null
    };
  }
  const connected = row.status === 'connected';
  return {
    state: connected ? 'connected' : 'needs_reauth',
    localConnectionId: row.id,
    providerConfigKey,
    externalConnectionId: row.external_connection_id,
    lastError: connected ? null : row.last_error
  };
}

/**
 * GitHub refused the stored authorization. The existing Reconnect button fixes
 * it. Only a live ('connected') connection flips, so a poll that fails after a deliberate Disconnect changes nothing. Owners are emailed once, when the status actually flips: the guarded
 * UPDATE returns a row only on that transition, so a poll that keeps failing
 * does not keep mailing.
 */
export async function markConnectionNeedsReauth(
  db: Db,
  workspaceId: string,
  localConnectionId: string,
  message: string,
  now: Date = new Date()
): Promise<void> {
  const flipped = await db
    .prepare(
      `UPDATE connections SET status='needs_reauth', last_error=?, updated_at=?::timestamptz
       WHERE id=? AND workspace_id=? AND status = 'connected'
       RETURNING provider, display_name`
    )
    .get<{ provider: string; display_name: string | null }>(
      message.slice(0, 500),
      now.toISOString(),
      localConnectionId,
      workspaceId
    );
  if (!flipped) return;
  try {
    await notifyIntegrationNeedsReauth(db, {
      workspaceId,
      provider: flipped.provider,
      accountLabel: flipped.display_name,
      reason: message.slice(0, 500)
    });
  } catch (notificationError) {
    console.error(
      'Failed to deliver Trevra integration reauthorization notification',
      notificationError
    );
  }
}

/** One indexed read, so the automation cycle can skip the poller for almost every workspace. */
export async function hasDueRepositories(db: Db, workspaceId: string, now: Date): Promise<boolean> {
  const iso = now.toISOString();
  const row = await db
    .prepare(
      `SELECT id FROM watched_repositories
       WHERE workspace_id=? AND next_poll_at <= ?::timestamptz
         AND (lease_until IS NULL OR lease_until <= ?::timestamptz)
       LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, iso, iso);
  return row !== undefined;
}

/**
 * Take the due repositories for one run. Row locks with SKIP LOCKED plus a
 * lease, the house claim pattern: two workers never poll the same repository,
 * and a worker that dies mid-run frees it after POLL_LEASE_MINUTES.
 */
export async function claimDueRepositories(
  db: Db,
  workspaceId: string,
  now: Date,
  limit: number
): Promise<WatchedRepository[]> {
  const iso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + POLL_LEASE_MINUTES * 60_000).toISOString();
  const rows = await db
    .prepare(
      `UPDATE watched_repositories SET lease_until=?::timestamptz
       WHERE workspace_id=? AND id IN (
         SELECT id FROM watched_repositories
         WHERE workspace_id=? AND next_poll_at <= ?::timestamptz
           AND (lease_until IS NULL OR lease_until <= ?::timestamptz)
         ORDER BY next_poll_at ASC, id ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${REPO_COLUMNS}`
    )
    .all<RepoRow>(leaseUntil, workspaceId, workspaceId, iso, iso, Math.max(1, Math.trunc(limit)));
  return rows
    .map(toRepository)
    .sort(
      (left, right) =>
        left.nextPollAt.localeCompare(right.nextPollAt) || left.id.localeCompare(right.id)
    );
}

export interface RepositoryPatch {
  status?: WatchedRepositoryStatus;
  lastError?: string | null;
  starsCursor?: Date;
  forksCursor?: Date;
  issuesCursor?: Date;
  repoEtag?: string | null;
  issuesEtag?: string | null;
  rateLimitedUntil?: Date | null;
  nextPollAt?: Date;
  lastPolledAt?: Date;
  lastSummary?: PollSummary;
  addUnresolved?: number;
}

/** Write what a run learned about one repository, and release its lease. */
export async function updateRepository(
  db: Db,
  workspaceId: string,
  repoId: string,
  patch: RepositoryPatch,
  now: Date = new Date()
): Promise<void> {
  const sets: string[] = ['updated_at=?::timestamptz', 'lease_until=NULL'];
  const params: unknown[] = [now.toISOString()];
  const put = (column: string, value: unknown, cast = ''): void => {
    sets.push(`${column}=?${cast}`);
    params.push(value);
  };
  // Cursors only move forward: a worker whose lease expired must not rewind one.
  const later = (column: string, value: Date): void => {
    const iso = value.toISOString();
    sets.push(`${column}=GREATEST(COALESCE(${column}, ?::timestamptz), ?::timestamptz)`);
    params.push(iso, iso);
  };
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.lastError !== undefined) put('last_error', patch.lastError);
  if (patch.starsCursor) later('stars_cursor', patch.starsCursor);
  if (patch.forksCursor) later('forks_cursor', patch.forksCursor);
  if (patch.issuesCursor) later('issues_cursor', patch.issuesCursor);
  if (patch.repoEtag !== undefined) put('repo_etag', patch.repoEtag);
  if (patch.issuesEtag !== undefined) put('issues_etag', patch.issuesEtag);
  if (patch.rateLimitedUntil !== undefined) {
    put(
      'rate_limited_until',
      patch.rateLimitedUntil ? patch.rateLimitedUntil.toISOString() : null,
      '::timestamptz'
    );
  }
  if (patch.nextPollAt) put('next_poll_at', patch.nextPollAt.toISOString(), '::timestamptz');
  if (patch.lastPolledAt) put('last_polled_at', patch.lastPolledAt.toISOString(), '::timestamptz');
  if (patch.lastSummary) put('last_summary_json', JSON.stringify(patch.lastSummary), '::jsonb');
  if (patch.addUnresolved) {
    sets.push('unresolved_total = unresolved_total + ?::int');
    params.push(patch.addUnresolved);
  }
  params.push(repoId, workspaceId);
  await db
    .prepare(`UPDATE watched_repositories SET ${sets.join(', ')} WHERE id=? AND workspace_id=?`)
    .run(...params);
}
