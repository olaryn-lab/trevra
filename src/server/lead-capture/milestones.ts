/**
 * Product and billing milestones: the deterministic rules that turn one into
 * an account signal, an Opportunity stage floor and an idempotency key.
 *
 * Pure: no I/O, and only type imports beyond the shared vocabulary, so Today,
 * demand, the recorder and the client agree on one list.
 */
import type { AccountSignalKind } from '../accounts/types.js';
import type { OpportunityStage } from '../opportunities.js';
import { GTM_MILESTONE_KINDS, type GtmMilestoneKind } from '../../shared/milestones.js';

export {
  GTM_MILESTONE_KINDS,
  MILESTONE_LABELS,
  isMilestoneKind,
  type GtmMilestoneKind
} from '../../shared/milestones.js';

export type MilestoneSourceType = 'inbound_submission' | 'stripe_event';

/**
 * `('signed_up',...)` for `kind NOT IN ${MILESTONE_KINDS_SQL}`. Built only from
 * the closed tuple above, never from input, so interpolation is safe.
 */
export const MILESTONE_KINDS_SQL = `(${GTM_MILESTONE_KINDS.map((kind) => `'${kind}'`).join(',')})`;

export const MILESTONE_SIGNAL_KIND: Record<GtmMilestoneKind, AccountSignalKind> = {
  signed_up: 'product-signed-up',
  activated: 'product-activated',
  integration_connected: 'product-integration-connected',
  usage_threshold_crossed: 'product-usage-threshold',
  paid: 'customer-paid',
  upgraded: 'customer-upgraded',
  cancelled: 'customer-cancelled'
};

/**
 * The stage an observed milestone guarantees. Adoption proves a qualified
 * conversation is warranted; a payment is a win. A signup, an upgrade and a
 * cancellation move nothing: Opportunities never move backwards and are never
 * closed as lost automatically.
 */
export const MILESTONE_MINIMUM_STAGE: Record<
  GtmMilestoneKind,
  Exclude<OpportunityStage, 'lost'> | null
> = {
  signed_up: null,
  activated: 'qualified',
  integration_connected: 'qualified',
  usage_threshold_crossed: 'qualified',
  paid: 'won',
  upgraded: null,
  cancelled: null
};

/** Kinds that can happen once per Person, whatever source reports them. */
export const ONE_TIME_MILESTONE_KINDS: ReadonlySet<GtmMilestoneKind> = new Set<GtmMilestoneKind>([
  'signed_up',
  'activated',
  'paid'
]);

/**
 * The deterministic idempotency key, unique per workspace.
 *
 * - One-time kinds collapse per Person, so the intake and Stripe reporting the
 *   same payment converge on one milestone.
 * - A cancellation collapses per subscription when the source names it.
 * - Everything else is one milestone per source event.
 */
export function milestoneKey(input: {
  kind: GtmMilestoneKind;
  contactId: string;
  sourceType: MilestoneSourceType;
  sourceId: string;
  externalObjectId?: string | null;
}): string {
  if (ONE_TIME_MILESTONE_KINDS.has(input.kind)) return `${input.kind}:contact:${input.contactId}`;
  if (input.kind === 'cancelled' && input.externalObjectId)
    return `cancelled:object:${input.externalObjectId}`;
  return `${input.kind}:${input.sourceType}:${input.sourceId}`;
}

/** The in-app page that proves a milestone signal: the Inbound screen, anchored. */
export function milestoneEvidencePath(milestoneId: string): string {
  return `/outreach/inbound?milestone=${encodeURIComponent(milestoneId)}`;
}
