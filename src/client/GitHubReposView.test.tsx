import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitHubRepoWatch, GitHubReposState } from './api';
import type { WorkspaceRole } from './auth-client';
import { GitHubReposView, repoStatusCopy } from './GitHubReposView';

const formatTime = (iso: string) => `at ${iso}`;

function repo(overrides: Partial<GitHubRepoWatch> = {}): GitHubRepoWatch {
  return {
    id: 'ghrepo_1',
    fullName: 'lemoncrow-lab/lemoncrow',
    url: 'https://github.com/lemoncrow-lab/lemoncrow',
    status: 'ok',
    lastError: null,
    rateLimitedUntil: null,
    nextPollAt: '2026-10-06T10:00:00.000Z',
    lastPolledAt: '2026-10-06T09:00:00.000Z',
    lastSummary: null,
    unresolvedTotal: 0,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides
  };
}

function state(
  repos: GitHubRepoWatch[],
  connection: GitHubReposState['connection']['state'] = 'connected'
): GitHubReposState {
  return { connection: { state: connection, lastError: null }, repos, limit: 10 };
}

function render(
  value: GitHubReposState | null,
  role: WorkspaceRole = 'owner',
  extra: { error?: string; busy?: string | null } = {}
): string {
  return renderToStaticMarkup(
    <GitHubReposView
      state={value}
      error={extra.error ?? ''}
      role={role}
      draft=""
      busy={extra.busy ?? null}
      formatTime={formatTime}
      onDraftChange={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
      onRetry={() => undefined}
    />
  );
}

describe('GitHubReposView', () => {
  it('says GitHub is not connected instead of showing zero activity', () => {
    const html = render(state([repo({ status: 'not_connected' })], 'not_connected'));
    expect(html).toContain('GitHub is not connected.');
    expect(html).toContain('Not checked: GitHub is not connected.');
    expect(html).not.toContain('0 new stars');

    const revoked = render(state([repo({ status: 'needs_reauth' })], 'needs_reauth'));
    expect(revoked).toContain('GitHub needs reconnecting.');
    expect(revoked).not.toContain('Nothing new since the previous check');
  });

  it('names the reset time when GitHub pauses the watch', () => {
    const html = render(
      state([repo({ status: 'rate_limited', rateLimitedUntil: '2026-10-06T13:00:00.000Z' })])
    );
    expect(html).toContain(
      'Paused by the GitHub rate limit; checking resumes at 2026-10-06T13:00:00.000Z.'
    );
    expect(
      repoStatusCopy(repo({ status: 'rate_limited', rateLimitedUntil: null }), formatTime)
    ).toBe('Paused by the GitHub rate limit; checking resumes when the limit resets.');
  });

  it('summarises a check that matched companies, and counts people it could not trace', () => {
    const checked = repo({
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
      },
      unresolvedTotal: 4
    });
    expect(repoStatusCopy(checked, formatTime)).toBe(
      'Checked at 2026-10-06T09:00:00.000Z: 3 new stars, 1 new fork, 1 new issue. 3 matched to a company (1 new account); 1 event not traceable to a company; 1 from companies marked not a fit.'
    );
    expect(render(state([checked]))).toContain(
      '4 events so far not traceable to a company. Counted, not stored.'
    );
  });

  it('lets only the owner add or remove repositories', () => {
    const owner = render(state([repo()]));
    expect(owner).toContain('aria-label="Stop watching lemoncrow-lab/lemoncrow"');
    expect(owner).toContain('Watch repository');

    const member = render(state([repo()]), 'member');
    expect(member).not.toContain('Stop watching');
    expect(member).not.toContain('Watch repository');
    expect(member).toContain('Only the workspace owner can choose which repositories to watch.');
    const memberEmpty = render(state([]), 'member');
    expect(memberEmpty).toContain(
      'Only the workspace owner can choose which repositories to watch.'
    );
    expect(memberEmpty).not.toContain('Watch repository');
  });

  it('shows neither owner controls nor the member line while the role is pending', () => {
    const html = render(state([repo()]), 'pending');
    expect(html).not.toContain('Stop watching');
    expect(html).not.toContain('Watch repository');
    expect(html).not.toContain('Only the workspace owner can');
  });

  it('offers a retry instead of loading forever when the first read failed', () => {
    const failed = render(null, 'owner', { error: 'Unable to load watched repositories.' });
    expect(failed).toContain('Unable to load watched repositories.');
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('Loading watched repositories.');
    expect(failed).not.toContain('Watch repository');
    const loading = render(null);
    expect(loading).toContain('Loading watched repositories.');
    expect(loading).not.toContain('Try again');
  });

  it('points a missing or revoked connection at Setup → Workspace', () => {
    expect(render(state([], 'not_connected'))).toContain('Connect it under Setup → Workspace');
    expect(render(state([], 'needs_reauth'))).toContain('reconnect it under Setup → Workspace');
  });

  it('disables adding at the repository limit', () => {
    const full = Array.from({ length: 10 }, (_, index) =>
      repo({ id: `ghrepo_${index}`, fullName: `lemoncrow-lab/repo-${index}` })
    );
    const html = render(state(full));
    expect(html).toContain('You are watching the maximum of 10. Remove one to add another.');
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });

  it('says so when a check left work for later or skipped the oldest activity', () => {
    const summary = {
      stars: 2,
      forks: 0,
      issues: 0,
      attached: 0,
      created: 0,
      unresolved: 0,
      ignoredRejected: 0,
      deferred: 3,
      burstTruncated: true
    };
    const copy = repoStatusCopy(repo({ lastSummary: summary }), formatTime);
    expect(copy).toContain('3 left for the next check');
    expect(copy).toContain('more activity arrived than one check reads, so the oldest was skipped');

    const idle = repoStatusCopy(
      repo({ lastSummary: { ...summary, stars: 0, burstTruncated: false } }),
      formatTime
    );
    expect(idle).toContain('3 left for the next check');
    expect(idle).not.toContain('Nothing new since the previous check');
  });

  it('shows errors and disables every control while an action is in flight', () => {
    const failed = render(state([repo()]), 'owner', { error: 'Repository limit reached.' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Repository limit reached.');

    const busy = render(state([repo()]), 'owner', { busy: 'add' });
    expect(busy).toMatch(/<input[^>]*disabled=""/);
    expect(busy).toMatch(/<button[^>]*aria-label="Stop watching[^"]*"[^>]*disabled=""/);
    expect(busy).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
