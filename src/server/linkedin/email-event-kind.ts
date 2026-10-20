import type { VerifiedEmailOutcome } from '../email-outcomes.js';

/** Single vocabulary for persisted campaign email events, branch keys and analytics. */
export type CampaignEmailEventKind = 'opened' | 'clicked' | VerifiedEmailOutcome;
export const EMAIL_REPLY_EVENT_KIND: CampaignEmailEventKind = 'reply';

const WORKFLOW_EMAIL_EVENTS = {
  email_replied: 'reply',
  email_bounced: 'bounce',
  email_opened: 'opened',
  email_clicked: 'clicked'
} as const satisfies Record<string, CampaignEmailEventKind>;

export function emailEventKindForCondition(condition: string): CampaignEmailEventKind | null {
  return WORKFLOW_EMAIL_EVENTS[condition as keyof typeof WORKFLOW_EMAIL_EVENTS] ?? null;
}

/** Preserve the old keys for previously enrolled campaigns as well as new events. */
export function emailEventBranchKeys(kind: CampaignEmailEventKind): string[] {
  const canonical = `external:email_${kind}`;
  const alias =
    kind === 'reply'
      ? 'external:email_replied'
      : kind === 'bounce'
        ? 'external:email_bounced'
        : null;
  return alias ? [canonical, alias] : [canonical];
}
