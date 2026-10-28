import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveLinkedInActionReview,
  getLinkedInActionReviews,
  type LinkedInActionReview
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { useOutreachRefresh } from './LinkedInSafety';
import { Panel } from './ui/layout';
import { Button } from './ui/primitives';

/** Holds and reviews exact queued LinkedIn writes before the Companion worker
 * acts. This is a workspace-wide queue, including non-campaign inbox replies. */
export function LinkedInActionApprovals() {
  const owner = useIsWorkspaceOwner();
  const [rows, setRows] = useState<LinkedInActionReview[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const latestRead = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++latestRead.current;
    try {
      const next = await getLinkedInActionReviews();
      if (requestId !== latestRead.current) return;
      setRows(next);
      setError('');
    } catch (cause) {
      if (requestId !== latestRead.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not load LinkedIn actions.');
    }
  }, []);
  useEffect(() => {
    void load();
    // The hosted worker plans and holds actions independently of the React
    // screen. Without a refresh, the owner may never see approvals that were
    // queued after this screen mounted, leaving a campaign apparently stuck.
    const refreshWhenVisible = () => {
      if (!document.hidden) void load();
    };
    const poll = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      // A slow response from an unmounted screen must never rewrite new state.
      latestRead.current += 1;
    };
  }, [load]);
  useOutreachRefresh(load);
  if (!rows.length && !error) return null;
  return (
    <Panel
      aria-label="LinkedIn browser action approvals"
      title="LinkedIn actions awaiting review"
      description="Review the exact recipient, account and message before authorizing an action."
      actions={
        <Button variant="ghost" onClick={() => void load()}>
          Refresh reviews
        </Button>
      }
    >
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <div className="li-review-list">
        {rows.map((row) => (
          <article className="li-review-item" key={row.actionId}>
            <div className="li-review-heading">
              <strong>{row.kind.replaceAll('_', ' ')}</strong>
              <span>{row.targetRef}</span>
            </div>
            <p className="li-review-meta">LinkedIn account: {row.seatKey}</p>
            {row.subject && (
              <p>
                <strong>Subject:</strong> {row.subject}
              </p>
            )}
            {row.body && <pre className="li-review-message">{row.body}</pre>}
            {row.threadUrn && (
              <details className="li-review-details">
                <summary>Technical details</summary>
                <p>Reply thread: {row.threadUrn}</p>
              </details>
            )}
            {row.hasAttachments && (
              <p className="li-review-warning">
                Attachment included. Review the original queued action before approving.
              </p>
            )}
            <div className="li-review-footer">
              <p>
                {row.policy.effect === 'deny'
                  ? `Blocked by workspace policy: ${row.policy.policyName}`
                  : 'Waiting for workspace owner approval.'}
              </p>
              {owner && row.policy.effect === 'require_approval' && (
                <Button
                  variant="primary"
                  disabled={busy !== '' || row.hasAttachments}
                  onClick={async () => {
                    setBusy(row.actionId);
                    try {
                      await approveLinkedInActionReview(row.actionId, row.contentHash);
                      await load();
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Action changed; refresh before review.'
                      );
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {busy === row.actionId ? 'Approving…' : 'Approve this action'}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
