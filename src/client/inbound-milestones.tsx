import type { InboundMilestone } from './api';
import { GTM_MILESTONE_KINDS, MILESTONE_LABELS } from '../shared/milestones';
import { relativeTime } from './LinkedInScreen';
import { Button } from './ui/primitives';

/** The closed milestone vocabulary in founder words, never the machine kind codes. */
export function milestoneKindsPhrase(): string {
  const labels = GTM_MILESTONE_KINDS.map((kind) => MILESTONE_LABELS[kind]);
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

/** A failed read is said out loud with a retry, never shown as an empty state. */
export function SectionLoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="capture-load-error">
      <div className="error-banner" role="alert">
        {message}
      </div>
      {onRetry && (
        <div className="capture-row-actions">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Product milestones are outcomes, not leads: they are listed here as
 * evidence (each anchored for the Today link and the account signal's
 * evidence URL), never as decision cards.
 */
export function MilestoneSection({
  milestones,
  error = '',
  onRetry
}: {
  /** Null while the first read is in flight: neither empty nor failed. */
  milestones: InboundMilestone[] | null;
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <section className="page-panel" aria-labelledby="inbound-milestones-title">
      <div className="section-heading">
        <div>
          <h3 id="inbound-milestones-title">Product milestones</h3>
          <p>Signups, activation, payments and cancellations reported by your product or Stripe.</p>
        </div>
      </div>
      {error ? (
        <SectionLoadError message={error} onRetry={onRetry} />
      ) : milestones === null ? (
        <p className="li-hint">Loading milestones…</p>
      ) : milestones.length === 0 ? (
        <div className="empty-state">
          <h4>No milestones yet</h4>
          <p>
            They appear when your product reports that a customer {milestoneKindsPhrase()}, or when
            you connect Stripe in Setup → Lead capture.
          </p>
        </div>
      ) : (
        <ul className="capture-milestone-list">
          {milestones.map((milestone) => (
            <li key={milestone.id} id={`milestone-${milestone.id}`}>
              <strong>
                {milestone.accountName ||
                  milestone.personName ||
                  milestone.personEmail ||
                  'A customer'}
              </strong>
              <span>{milestone.label}</span>
              <small>
                {milestone.sourceType === 'stripe_event' ? 'Stripe' : 'Your product'} ·{' '}
                <time dateTime={milestone.occurredAt} title={milestone.occurredAt.slice(0, 10)}>
                  {relativeTime(milestone.occurredAt)}
                </time>
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
