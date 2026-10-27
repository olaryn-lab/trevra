import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveLinkedInActionReview,
  getLinkedInActionReviews,
  type LinkedInActionReview
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { useOutreachRefresh } from './LinkedInSafety';

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
    <section className="page-panel" aria-label="LinkedIn browser action approvals">
      <h3>LinkedIn actions awaiting review</h3>
      <p>
        Each approval applies to one exact action, message and account. LinkedIn automation uses
        your connected browser and may carry account restrictions.
      </p>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {rows.map((row) => (
        <article className="panel" key={row.actionId}>
          <p>
            <strong>{row.kind.replaceAll('_', ' ')}</strong> · {row.seatKey} · {row.targetRef}
          </p>
          {row.subject && (
            <p>
              <strong>Subject:</strong> {row.subject}
            </p>
          )}
          {row.body && (
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.body}</pre>
          )}
          {row.threadUrn && <p>Reply thread: {row.threadUrn}</p>}
          {row.hasAttachments && (
            <p>Attachment included; review the original queued action before approving.</p>
          )}
          <p>
            {row.policy.effect === 'deny'
              ? `Blocked by workspace policy: ${row.policy.policyName}`
              : 'Waiting for workspace owner approval.'}
          </p>
          {owner && row.policy.effect === 'require_approval' && (
            <button
              type="button"
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
            </button>
          )}
        </article>
      ))}
      <button type="button" className="ghost-button" onClick={() => void load()}>
        Refresh LinkedIn reviews
      </button>
    </section>
  );
}
