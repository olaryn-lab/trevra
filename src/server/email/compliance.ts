import type { Db } from '../db.js';

/*
 * The seam between outreach email and the sender's legal footer. Phase E
 * registers the real provider in createApp; until then every outreach plan is
 * blocked rather than sent without a footer.
 */

export interface EmailComplianceProvider {
  /** Footer appended to every outreach email body (legal name, postal address, opt-out line), or null if unavailable. */
  footer(db: Db, workspaceId: string): Promise<string | null>;
  /** Extra plan blockers (Phase E: sender_postal_address_missing, sender_privacy_url_missing, ...). */
  blockers(db: Db, workspaceId: string, listId: string | null): Promise<string[]>;
}

/** The opt-out sentence Trevra writes into outreach bodies. Inbound classification strips it from quotes. */
export const OUTREACH_OPT_OUT_SENTENCE =
  'If you would rather not hear from me, use the unsubscribe option your mail app shows for this email, or reply and say so.';

/** The unsubscribe line appended to skill-drafted emails. */
export const SKILL_DRAFT_UNSUBSCRIBE_LINE = "Reply 'unsubscribe' to never hear from us again.";

const defaultProvider: EmailComplianceProvider = {
  footer: async () => null,
  blockers: async () => ['email_compliance_footer_unavailable']
};

let current: EmailComplianceProvider = defaultProvider;

export function registerEmailComplianceProvider(provider: EmailComplianceProvider): void {
  current = provider;
}

export function emailComplianceProvider(): EmailComplianceProvider {
  return current;
}

/** Restore the default provider (tests). */
export function resetEmailComplianceProvider(): void {
  current = defaultProvider;
}
