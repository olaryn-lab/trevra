import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveCampaignEmailReview,
  getCampaignEmailReviews,
  type CampaignEmailReview
} from './api';
import { AiDraftPanel } from './AiDraftPanel';
import { useWorkspaceCan } from './auth-client';
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
  // Owner or manager (`outreach.approve`, src/server/roles.ts).
  const owner = useWorkspaceCan('outreach.approve');
  const [reviews, setReviews] = useState<CampaignEmailReview[]>([]);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const [drafting, setDrafting] = useState('');
  // Closing the AI panel brings back that row's "Draft with AI" button; focus
  // returns to it instead of falling to the page.
  const returnFocus = useRef('');
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
            <pre className="li-review-message">
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
                : 'Waiting for a workspace owner or manager to approve.'}
            </p>
            {row.policy.effect !== 'deny' && drafting !== row.actionId && (
              <Button
                ref={(node) => {
                  if (node && returnFocus.current === row.actionId) {
                    returnFocus.current = '';
                    node.focus();
                  }
                }}
                disabled={busy !== ''}
                onClick={() => setDrafting(row.actionId)}
              >
                Draft with AI
              </Button>
            )}
            {owner &&
              row.policy.effect !== 'deny' &&
              needsApproval(row) &&
              drafting !== row.actionId && (
                <Button
                  variant="primary"
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
                </Button>
              )}
            {drafting === row.actionId && (
              <AiDraftPanel
                campaignId={campaignId}
                memberId={row.memberId}
                stepId={row.workflowStepId}
                actionId={row.actionId}
                owner={owner}
                onClose={() => {
                  returnFocus.current = row.actionId;
                  setDrafting('');
                }}
                onApproved={async () => {
                  setDrafting('');
                  await load();
                }}
              />
            )}
          </article>
        ))}
      <Button variant="ghost" onClick={() => void load()}>
        Refresh email reviews
      </Button>
    </section>
  );
}
