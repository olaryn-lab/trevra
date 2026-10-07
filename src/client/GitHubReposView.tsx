import { ExternalLink, Github, Trash2 } from 'lucide-react';
import type {
  GitHubConnectionState,
  GitHubRepoStatus,
  GitHubRepoWatch,
  GitHubReposState
} from './api';
import { EmptyState, Panel } from './ui/layout';
import { plural } from './ui/plural';
import { Button, Field, Input } from './ui/primitives';

const STATUS_LABELS: Record<GitHubRepoStatus, string> = {
  pending: 'Waiting',
  ok: 'Watching',
  not_found: 'Not found',
  rate_limited: 'Rate limited',
  needs_reauth: 'Needs reconnect',
  not_connected: 'Not connected',
  error: 'Check failed'
};

/** Reuses the shared `.connection-status` pill: `connected` is green, `error` is red. */
function statusClass(status: GitHubRepoStatus): string {
  if (status === 'ok') return 'connection-status connected';
  if (status === 'needs_reauth' || status === 'error' || status === 'not_found') {
    return 'connection-status error';
  }
  return 'connection-status';
}

/** What the card says about the connection itself. Null when there is nothing to say. */
export function connectionNotice(state: GitHubConnectionState): string | null {
  if (state === 'connected') return null;
  if (state === 'needs_reauth') {
    return 'GitHub needs reconnecting. Nothing is read until you reconnect it under Connections.';
  }
  return 'GitHub is not connected. Add it under Connections; until then no stars, forks or issues are read.';
}

function checkedCopy(repo: GitHubRepoWatch, formatTime: (iso: string) => string): string {
  const when = repo.lastPolledAt ? formatTime(repo.lastPolledAt) : 'recently';
  const summary = repo.lastSummary;
  if (!summary || summary.stars + summary.forks + summary.issues === 0) {
    return `Checked ${when}. Nothing new since the previous check.`;
  }
  const seen = [
    plural(summary.stars, 'new star'),
    plural(summary.forks, 'new fork'),
    plural(summary.issues, 'new issue')
  ].join(', ');
  const notes = [
    `${summary.attached + summary.created} matched to a company (${plural(summary.created, 'new account')})`,
    summary.unresolved > 0
      ? `${plural(summary.unresolved, 'event')} not traceable to a company`
      : null,
    summary.ignoredRejected > 0
      ? `${summary.ignoredRejected} from companies marked not a fit`
      : null,
    summary.deferred > 0 ? `${summary.deferred} left for the next check` : null,
    summary.burstTruncated
      ? 'more activity arrived than one check reads, so the oldest was skipped'
      : null
  ].filter((note): note is string => note !== null);
  return `Checked ${when}: ${seen}. ${notes.join('; ')}.`;
}

export function repoStatusCopy(repo: GitHubRepoWatch, formatTime: (iso: string) => string): string {
  switch (repo.status) {
    case 'pending':
      return 'Waiting for the first check.';
    case 'not_connected':
      return 'Not checked: GitHub is not connected.';
    case 'needs_reauth':
      return 'Not checked: GitHub needs reconnecting.';
    case 'rate_limited':
      return `Paused by the GitHub rate limit until ${
        repo.rateLimitedUntil ? formatTime(repo.rateLimitedUntil) : 'it resets'
      }. Nothing is lost; checking resumes then.`;
    case 'not_found':
      return 'GitHub cannot find this repository, or it is private. Only public repositories can be watched.';
    case 'error':
      return `The last check failed (${repo.lastError ?? 'unknown error'}). Trevra tries again within the hour.`;
    case 'ok':
      return checkedCopy(repo, formatTime);
  }
}

export interface GitHubReposViewProps {
  state: GitHubReposState | null;
  error: string;
  isOwner: boolean;
  draft: string;
  /** 'add' while adding, a repository id while removing it, otherwise null. */
  busy: string | null;
  formatTime: (iso: string) => string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (repo: GitHubRepoWatch) => void;
}

export function GitHubReposView({
  state,
  error,
  isOwner,
  draft,
  busy,
  formatTime,
  onDraftChange,
  onAdd,
  onRemove
}: GitHubReposViewProps) {
  const notice = state ? connectionNotice(state.connection.state) : null;
  const atLimit = state !== null && state.repos.length >= state.limit;
  return (
    <Panel
      id="github-repos"
      title="GitHub repositories"
      description="Stars, forks and issues on your public repositories, matched to companies from public profile data. Read-only."
      icon={<Github size={16} aria-hidden="true" />}
    >
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="gh-repos-notice" role="status">
          {notice}
        </p>
      ) : null}
      {state === null ? (
        <p className="gh-repos-quiet">Loading watched repositories.</p>
      ) : state.repos.length === 0 ? (
        <EmptyState
          title="No repositories watched"
          description={
            isOwner
              ? 'Add a public repository you own, for example lemoncrow-lab/lemoncrow.'
              : 'The workspace owner chooses which repositories to watch.'
          }
        />
      ) : (
        <ul className="gh-repos-list">
          {state.repos.map((repo) => (
            <li className="gh-repos-row" key={repo.id}>
              <div className="gh-repos-main">
                <a href={repo.url} target="_blank" rel="noreferrer">
                  {repo.fullName} <ExternalLink size={12} aria-hidden="true" />
                </a>
                <span className={statusClass(repo.status)}>{STATUS_LABELS[repo.status]}</span>
                <p>{repoStatusCopy(repo, formatTime)}</p>
                {repo.unresolvedTotal > 0 ? (
                  <p>
                    {plural(repo.unresolvedTotal, 'event')} so far not traceable to a company.
                    Counted, not stored.
                  </p>
                ) : null}
              </div>
              {isOwner ? (
                <Button
                  variant="ghost"
                  aria-label={`Stop watching ${repo.fullName}`}
                  disabled={busy === repo.id}
                  onClick={() => onRemove(repo)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {isOwner && state ? (
        <form
          className="gh-repos-add"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <Field
            label="Repository"
            hint={
              atLimit
                ? `You are watching the maximum of ${state.limit}. Remove one to add another.`
                : 'owner/name or a github.com link. Public repositories only.'
            }
          >
            <Input
              value={draft}
              placeholder="lemoncrow-lab/lemoncrow"
              autoComplete="off"
              spellCheck={false}
              disabled={atLimit || busy === 'add'}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            type="submit"
            disabled={atLimit || busy === 'add' || draft.trim() === ''}
          >
            Watch repository
          </Button>
        </form>
      ) : null}
    </Panel>
  );
}
