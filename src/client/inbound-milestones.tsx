import type { InboundMilestone } from './api';
import { GTM_MILESTONE_KINDS } from '../shared/milestones';

/**
 * Product milestones are outcomes, not leads: they are listed here as
 * evidence (each anchored for the Today link and the account signal's
 * evidence URL), never as decision cards.
 */
export function MilestoneSection({ milestones }: { milestones: InboundMilestone[] }) {
  return (
    <section className="page-panel" aria-labelledby="inbound-milestones-title">
      <div className="section-heading">
        <div>
          <h3 id="inbound-milestones-title">Product milestones</h3>
          <p>Signups, activation, payments and cancellations reported by your product or Stripe.</p>
        </div>
      </div>
      {milestones.length === 0 ? (
        <div className="empty-state">
          <h4>No milestones yet</h4>
          <p>
            Send one of{' '}
            {GTM_MILESTONE_KINDS.map((kind, index) => (
              <span key={kind}>
                {index > 0 && ', '}
                <code>{kind}</code>
              </span>
            ))}{' '}
            as the <code>kind</code> through a capture source, or connect Stripe in Setup → Lead
            capture.
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
                <time dateTime={milestone.occurredAt}>{milestone.occurredAt.slice(0, 10)}</time>
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
