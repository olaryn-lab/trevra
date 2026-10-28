import { useCallback, useEffect, useState } from 'react';
import {
  approveLinkedInWithdrawalReview,
  getLinkedInWithdrawalReviews,
  type LinkedInWithdrawalReview
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { useOutreachRefresh } from './LinkedInSafety';
import { Panel } from './ui/layout';
import { Button } from './ui/primitives';

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
    <Panel
      aria-label="Withdrawal approval queue"
      title="Pending invitation withdrawals"
      description="Review the LinkedIn account and recipient before withdrawing an invitation."
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
          <article key={row.withdrawalId} className="li-review-item">
            <div className="li-review-heading">
              <strong>Withdraw invitation</strong>
              <span>{row.targetRef}</span>
            </div>
            <p className="li-review-meta">
              LinkedIn account: {row.seatKey} · Pending {row.pendingDays ?? 'unknown'} days
            </p>
            <details className="li-review-details">
              <summary>Technical details</summary>
              <p>Invite: {row.actionId}</p>
            </details>
            <div className="li-review-footer">
              <p>
                {row.policy.effect === 'deny'
                  ? `Blocked by workspace policy: ${row.policy.policyName}`
                  : 'Waiting for workspace owner approval.'}
              </p>
              {owner && row.policy.effect === 'require_approval' && (
                <Button
                  variant="primary"
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
                  {busy === row.withdrawalId ? 'Approving…' : 'Approve withdrawal'}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}
