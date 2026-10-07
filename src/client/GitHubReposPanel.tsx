import { useCallback, useEffect, useState } from 'react';
import { getGitHubRepos, unwatchGitHubRepo, watchGitHubRepo, type GitHubReposState } from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { GitHubReposView } from './GitHubReposView';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import './github-repos.css';

/** Setup -> Workspace: which public repositories feed GitHub traction signals. */
export function GitHubReposPanel({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [state, setState] = useState<GitHubReposState | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await getGitHubRepos());
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to load watched repositories.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const fullName = draft.trim();
    if (!fullName) return;
    setBusy('add');
    try {
      const repo = await watchGitHubRepo(fullName);
      setDraft('');
      setToast(`Watching ${repo.fullName}.`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to watch that repository.'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (repoId: string, fullName: string) => {
    setBusy(repoId);
    try {
      await unwatchGitHubRepo(repoId);
      setToast(`Stopped watching ${fullName}.`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to stop watching that repository.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <GitHubReposView
      state={state}
      error={error}
      isOwner={isOwner}
      draft={draft}
      busy={busy}
      formatTime={relativeTime}
      onDraftChange={setDraft}
      onAdd={() => void add()}
      onRemove={(repo) => void remove(repo.id, repo.fullName)}
    />
  );
}
