import { useCallback, useEffect, useState } from 'react';
import {
  approveCampaignEmailReview,
  getCampaignEmailReviews,
  type CampaignEmailReview
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { useOutreachRefresh } from './LinkedInSafety';

/**
 * A message is reviewed with its actual rendered content: no campaign-wide
 * approval for future generated drafts. Changing content invalidates its hash.
 */
export function CampaignEmailApprovals({ campaignId }: { campaignId: string }) {
  const owner = useIsWorkspaceOwner();
  const [reviews, setReviews] = useState<CampaignEmailReview[]>([]);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      const rows = await getCampaignEmailReviews(campaignId);
      setReviews(rows);
      setFailure('');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not read campaign email reviews.');
    }
  }, [campaignId]);
  useEffect(() => {
    void load();
  }, [load]);
  useOutreachRefresh(load);
  const pending = reviews.filter(
    (row) => row.policy.effect === 'require_approval' && !row.approved
  );
  if (!failure && !pending.length && !reviews.some((row) => row.policy.effect === 'deny'))
    return null;
  return (
    <section className="panel" aria-label="Campaign email approvals">
      <h3>Review campaign emails</h3>
      <p>
        Each approval covers this exact recipient, sender, subject, body, legal footer and tracking
        setting. Any change requires a fresh review.
      </p>
      {failure && (
        <div className="error-banner" role="alert">
          {failure}
        </div>
      )}
      {reviews
        .filter(
          (row) =>
            row.policy.effect === 'deny' ||
            (row.policy.effect === 'require_approval' && !row.approved)
        )
        .map((row) => (
          <article key={row.actionId} className="panel">
            <p>
              <strong>To:</strong> {row.recipient} <strong>From:</strong>{' '}
              {row.sender ?? 'No verified sender'}
            </p>
            <p>
              <strong>Subject:</strong> {row.subject}
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {row.body}
              {'\n\n'}
              {row.footer}
            </pre>
            <p>
              Tracking:{' '}
              {row.tracking === 'off'
                ? 'Off'
                : row.tracking === 'opens'
                  ? 'Open pixel'
                  : 'Open pixel + click redirects'}{' '}
              · Threaded: {row.threaded ? 'Yes' : 'No'}
            </p>
            <p>
              {row.policy.effect === 'deny'
                ? `Blocked by workspace policy: ${row.policy.policyName}`
                : 'Waiting for workspace owner approval.'}
            </p>
            {owner && row.policy.effect === 'require_approval' && (
              <button
                type="button"
                disabled={busy !== '' || !row.sender}
                onClick={async () => {
                  setBusy(row.actionId);
                  try {
                    await approveCampaignEmailReview(campaignId, row.actionId, row.contentHash);
                    await load();
                  } catch (error) {
                    setFailure(
                      error instanceof Error
                        ? error.message
                        : 'The email changed. Refresh and review again.'
                    );
                  } finally {
                    setBusy('');
                  }
                }}
              >
                {busy === row.actionId ? 'Approving…' : 'Approve this exact email'}
              </button>
            )}
          </article>
        ))}
      <button type="button" className="ghost-button" onClick={() => void load()}>
        Refresh email reviews
      </button>
    </section>
  );
}
