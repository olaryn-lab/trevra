import { useCallback, useEffect, useState } from 'react';
import {
  approveCampaignEmailReview,
  getCampaignEmailReviews,
  type CampaignEmailReview
} from './api';
import { AiDraftPanel } from './AiDraftPanel';
import { useIsWorkspaceOwner } from './auth-client';
import { useOutreachRefresh } from './LinkedInSafety';
import { Button } from './ui/primitives';

/** Needs a human: policy asks for review, or the body is AI drafted (TRV-039). */
const needsApproval = (row: CampaignEmailReview) =>
  (row.policy.effect === 'require_approval' || row.aiDraft !== null) && !row.approved;

/**
 * A message is reviewed with its actual rendered content: no campaign-wide
 * approval for future generated drafts. Changing content invalidates its hash.
 */
export function CampaignEmailApprovals({ campaignId }: { campaignId: string }) {
  const owner = useIsWorkspaceOwner();
  const [reviews, setReviews] = useState<CampaignEmailReview[]>([]);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const [drafting, setDrafting] = useState('');
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
  const pending = reviews.filter(needsApproval);
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
        .filter((row) => row.policy.effect === 'deny' || needsApproval(row))
        .map((row) => (
          <article key={row.actionId} className="panel">
            <p>
              <strong>To:</strong> {row.recipient} <strong>From:</strong>{' '}
              {row.sender ?? 'No verified sender'}
            </p>
            <p>
              <strong>Subject:</strong> {row.subject}
            </p>
            {row.aiDraft && (
              <p>
                AI-drafted body
                {row.aiDraft.modelLabel ? ` (${row.aiDraft.modelLabel})` : ''}. It never sends
                without approval of this exact text.
              </p>
            )}
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
            {row.policy.effect !== 'deny' && drafting !== row.actionId && (
              <Button disabled={busy !== ''} onClick={() => setDrafting(row.actionId)}>
                Draft with AI
              </Button>
            )}
            {owner &&
              row.policy.effect !== 'deny' &&
              needsApproval(row) &&
              drafting !== row.actionId && (
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
            {drafting === row.actionId && (
              <AiDraftPanel
                campaignId={campaignId}
                memberId={row.memberId}
                stepId={row.workflowStepId}
                actionId={row.actionId}
                owner={owner}
                onClose={() => setDrafting('')}
                onApproved={async () => {
                  setDrafting('');
                  await load();
                }}
              />
            )}
          </article>
        ))}
      <button type="button" className="ghost-button" onClick={() => void load()}>
        Refresh email reviews
      </button>
    </section>
  );
}
