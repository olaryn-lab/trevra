import type { Db } from '../db.js';

/*
 * The seam between outreach email and the sender's legal footer. The real
 * provider (src/server/compliance/provider.ts) is registered at process entry
 * in src/server/index.ts and src/worker/index.ts, never inside createApp; the
 * default blocks every outreach plan rather than send without a footer.
 */

/** A plan blocker the provider names, passed through to the GTM plan unchanged. */
export interface EmailComplianceIssue {
  code: string;
  message: string;
  actionHref?: string;
}

export interface EmailComplianceProvider {
  /** Footer appended to every outreach email body (legal name, postal address, opt-out line), or null if unavailable. */
  footer(db: Db, workspaceId: string): Promise<string | null>;
  /** Plan blockers (sender_postal_address_missing, sender_privacy_url_missing, ...). */
  blockers(db: Db, workspaceId: string, listId: string | null): Promise<EmailComplianceIssue[]>;
}

/** The opt-out sentence that ends every outreach footer. Inbound classification strips it from quotes. */
export const OUTREACH_OPT_OUT_SENTENCE =
  'If you would rather not hear from me, use the unsubscribe option your mail app shows for this email, or reply and say so.';

/** The unsubscribe line appended to skill-drafted emails. */
export const SKILL_DRAFT_UNSUBSCRIBE_LINE = "Reply 'unsubscribe' to never hear from us again.";

/** The fail-closed blocker: no footer can be built for this workspace right now. */
export function emailComplianceFooterUnavailable(): EmailComplianceIssue {
  return {
    code: 'email_compliance_footer_unavailable',
    message:
      "Trevra could not build this workspace's email compliance footer (postal address, privacy policy URL, opt-out line). Check the sender identity in Workspace settings, or try again.",
    actionHref: '/setup/workspace'
  };
}

const defaultProvider: EmailComplianceProvider = {
  footer: async () => null,
  blockers: async () => [emailComplianceFooterUnavailable()]
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
