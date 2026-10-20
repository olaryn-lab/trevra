import { useCallback, useEffect, useState } from 'react';
import {
  approveLinkedInWithdrawalReview,
  getLinkedInWithdrawalReviews,
  type LinkedInWithdrawalReview
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { useOutreachRefresh } from './LinkedInSafety';

export function LinkedInWithdrawalApprovals() {
  const owner = useIsWorkspaceOwner();
  const [rows, setRows] = useState<LinkedInWithdrawalReview[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setRows(await getLinkedInWithdrawalReviews());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load withdrawal reviews.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useOutreachRefresh(load);
  if (!rows.length && !error) return null;
  return (
    <section className="page-panel" aria-label="Withdrawal approval queue">
      <h3>Pending invite withdrawal approvals</h3>
      <p>
        Each withdrawal removes one pending invitation on the named account. Review the exact
        account and recipient before authorizing.
      </p>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {rows.map((row) => (
        <article key={row.withdrawalId} className="panel">
          <p>
            <strong>Account:</strong> {row.seatKey} · <strong>Invite target:</strong>{' '}
            {row.targetRef}
          </p>
          <p>
            Pending for {row.pendingDays ?? 'unknown'} days · Invite {row.actionId}
          </p>
          <p>
            {row.policy.effect === 'deny'
              ? `Blocked by workspace policy: ${row.policy.policyName}`
              : 'Exact withdrawal requires workspace owner approval.'}
          </p>
          {owner && row.policy.effect === 'require_approval' && (
            <button
              type="button"
              disabled={busy !== ''}
              onClick={async () => {
                setBusy(row.withdrawalId);
                try {
                  await approveLinkedInWithdrawalReview(row.withdrawalId, row.contentHash);
                  await load();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Withdrawal changed; refresh before approval.'
                  );
                } finally {
                  setBusy('');
                }
              }}
            >
              {busy === row.withdrawalId ? 'Approving…' : 'Approve this withdrawal'}
            </button>
          )}
        </article>
      ))}
      <button type="button" className="ghost-button" onClick={() => void load()}>
        Refresh withdrawal reviews
      </button>
    </section>
  );
}
