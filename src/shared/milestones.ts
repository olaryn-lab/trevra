/**
 * The closed product-milestone vocabulary (GTM roadmap contract 3).
 *
 * Shared so the inbound screen recognises a milestone submission without a
 * server round trip. `src/server/lead-capture/milestones.ts` re-exports these
 * names and owns the server-side rules.
 */
export const GTM_MILESTONE_KINDS = [
  'signed_up',
  'activated',
  'integration_connected',
  'usage_threshold_crossed',
  'paid',
  'upgraded',
  'cancelled'
] as const;

export type GtmMilestoneKind = (typeof GTM_MILESTONE_KINDS)[number];

const KINDS = new Set<string>(GTM_MILESTONE_KINDS);

export function isMilestoneKind(kind: unknown): kind is GtmMilestoneKind {
  return typeof kind === 'string' && KINDS.has(kind);
}

/** Past-tense verb phrase: "Acme activated", "A person at this account paid." */
export const MILESTONE_LABELS: Record<GtmMilestoneKind, string> = {
  signed_up: 'signed up',
  activated: 'activated',
  integration_connected: 'connected an integration',
  usage_threshold_crossed: 'crossed a usage threshold',
  paid: 'paid',
  upgraded: 'upgraded',
  cancelled: 'cancelled'
};
