import { OUTREACH_OPT_OUT_SENTENCE } from './compliance.js';
import { mailProviderFor } from './deliverability.js';
import type { MailProvider, OutreachUnsubscribeMode } from './types.js';

/*
 * POLICY (Phase G, founder decision): how outreach email carries its opt-out.
 *
 * - Gmail and Microsoft 365 outreach MUST carry RFC 8058 List-Unsubscribe and
 *   List-Unsubscribe-Post headers (requireListUnsubscribe). Unchanged since Phase D.
 * - Zoho Mail outreach is the one exception. Zoho's REST send API cannot set
 *   those headers, and Trevra adds no SMTP path. Zoho outreach therefore carries
 *   its opt-out in the visible compliance footer, whose opt-out sentence is
 *   swapped for a reply-to-unsubscribe sentence. Inbound replies saying
 *   "unsubscribe" suppress the Person (src/server/email/inbound-mailbox.ts).
 *
 * The mode is chosen at prepare time from the sending connection's provider,
 * stored in the hashed approval payload, and enforced again here at send time,
 * before any delivery row or provider call. Nothing else may relax it.
 */

export const OUTREACH_UNSUBSCRIBE_MODES = [
  'list_unsubscribe_headers',
  'footer_and_reply'
] as const satisfies readonly OutreachUnsubscribeMode[];

/** The footer opt-out line Zoho outreach carries instead of the header-mode sentence. */
export const OUTREACH_REPLY_OPT_OUT_SENTENCE =
  'If you would rather not hear from me again, reply with "unsubscribe" and I will not email you again.';

export function outreachUnsubscribeModeFor(provider: MailProvider): OutreachUnsubscribeMode {
  return provider === 'zoho' ? 'footer_and_reply' : 'list_unsubscribe_headers';
}

export function parseOutreachUnsubscribeMode(value: unknown): OutreachUnsubscribeMode | null {
  return (OUTREACH_UNSUBSCRIBE_MODES as readonly unknown[]).includes(value)
    ? (value as OutreachUnsubscribeMode)
    : null;
}

/**
 * The compliance footer an outreach body must end with in this mode. In
 * footer_and_reply the header-mode opt-out sentence is replaced by the reply
 * sentence. It must appear exactly once [E-A3], or there is no safe footer and
 * the caller refuses (null).
 */
export function footerForUnsubscribeMode(
  footer: string,
  mode: OutreachUnsubscribeMode
): string | null {
  if (mode === 'list_unsubscribe_headers') return footer;
  const parts = footer.split(OUTREACH_OPT_OUT_SENTENCE);
  if (parts.length !== 2) return null;
  return parts.join(OUTREACH_REPLY_OPT_OUT_SENTENCE);
}

export class UnsubscribePolicyError extends Error {
  readonly status = 409;
}

/** Enforce the POLICY above for one send. Throws before any delivery row exists. */
export function assertUnsubscribeModeAllowed(input: {
  provider: string;
  purpose: 'outreach' | 'reply' | 'other';
  requireListUnsubscribe: boolean;
  unsubscribeMode: OutreachUnsubscribeMode | null;
}): void {
  if (mailProviderFor(input.provider) === 'zoho') {
    if (input.requireListUnsubscribe) {
      throw new UnsubscribePolicyError(
        'Zoho Mail cannot send the one-click unsubscribe header this email was approved with; nothing was sent.'
      );
    }
    if (input.purpose !== 'outreach') {
      throw new UnsubscribePolicyError(
        'Trevra sends only approved outreach email through Zoho Mail; nothing was sent.'
      );
    }
    if (input.unsubscribeMode !== 'footer_and_reply') {
      throw new UnsubscribePolicyError(
        'This outreach email was not approved for Zoho Mail, whose opt-out is the reply-to-unsubscribe footer; nothing was sent. Prepare it again.'
      );
    }
    return;
  }
  if (input.unsubscribeMode === 'footer_and_reply') {
    throw new UnsubscribePolicyError(
      'Reply-to-unsubscribe is allowed only for Zoho Mail; Gmail and Microsoft 365 outreach must carry the one-click unsubscribe header; nothing was sent.'
    );
  }
  if (input.unsubscribeMode === 'list_unsubscribe_headers' && !input.requireListUnsubscribe) {
    throw new UnsubscribePolicyError(
      'This outreach email names one-click unsubscribe but was not approved with it; nothing was sent.'
    );
  }
}
