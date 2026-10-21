import { useCallback, useEffect, useState } from 'react';
import {
  prepareRedditCommentAction,
  listRedditCommentActions,
  approveRedditCommentAction,
  executeRedditCommentAction,
  type RedditCommentReview
} from './api';
import { useIsWorkspaceOwner } from './auth-client';

export function RedditCommentPanel({ setToast }: { setToast: (message: string) => void }) {
  const owner = useIsWorkspaceOwner();
  const [rows, setRows] = useState<RedditCommentReview[]>([]);
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [postedLink, setPostedLink] = useState('');
  const refresh = useCallback(async () => {
    try {
      setRows(await listRedditCommentActions());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load prepared comments.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (task: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    try {
      await task();
      setToast(message);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action could not be completed.');
      try {
        setRows(await listRedditCommentActions());
      } catch {
        /* retain existing rows */
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="page-panel" aria-label="Reddit comment approvals">
      <div className="section-heading">
        <div>
          <h3>Reddit comment review</h3>
          <p>
            Prepare a comment first. It is never posted simply by creating a draft. Publish only
            after reviewing the exact thread and text.
          </p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await prepareRedditCommentAction({ url, body });
            setUrl('');
            setBody('');
          }, 'Comment prepared for review. Nothing was posted.');
        }}
      >
        <label>
          Reddit thread URL
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.reddit.com/r/.../comments/..."
            maxLength={500}
            required
          />
        </label>
        <label>
          Comment to prepare
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            maxLength={10000}
            required
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>
          Prepare exact comment
        </button>
      </form>
      {error && (
        <p role="alert" className="li-post-error">
          {error}
        </p>
      )}
      {postedLink && (
        <p role="status">
          Reddit confirmed publication.{' '}
          <a href={postedLink} target="_blank" rel="noreferrer">
            View posted comment
          </a>
        </p>
      )}
      <div className="section-heading">
        <h4>Pending and unresolved</h4>
        <button
          className="ghost-button"
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="empty-copy">No pending Reddit comments.</p>
      ) : (
        rows.map((item) => (
          <article key={item.id} className="panel">
            <p>
              <strong>Thread: </strong>
              <a href={item.threadUrl} target="_blank" rel="noreferrer">
                {item.threadUrl}
              </a>
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.body}</pre>
            <p>
              <strong>Status:</strong> {item.status} · <strong>Policy:</strong> {item.policy.effect}
              {item.approved ? ' · Exact payload approved' : ''}
            </p>
            {item.status === 'unknown' || item.status === 'executing' ? (
              <p role="alert">
                Outcome uncertain. Check the thread manually. Do not retry this comment.
              </p>
            ) : null}
            {item.policy.effect === 'deny' && <p>Workspace policy blocks this write.</p>}
            {item.status === 'prepared' &&
              owner &&
              item.policy.effect === 'require_approval' &&
              !item.approved && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => approveRedditCommentAction(item.id, item.contentHash),
                      'Exact comment approved, not posted.'
                    )
                  }
                >
                  Approve exact comment
                </button>
              )}
            {item.status === 'prepared' &&
              owner &&
              item.policy.effect !== 'deny' &&
              (item.approved || item.policy.effect === 'allow') && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await executeRedditCommentAction(item.id);
                      if (!result.posted)
                        throw new Error(result.reason ?? 'Reddit did not confirm publication.');
                      setPostedLink(result.externalRef ?? item.threadUrl);
                    }, 'Reddit confirmed publication.')
                  }
                >
                  Post approved comment
                </button>
              )}
            {item.status === 'failed' && (
              <p>Posting failed. Reconciliation is required; no automatic retry.</p>
            )}
          </article>
        ))
      )}
    </section>
  );
}
