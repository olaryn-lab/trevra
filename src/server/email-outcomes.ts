export const VERIFIED_EMAIL_OUTCOMES = [
  'reply',
  'unsubscribe',
  'bounce',
  'delivery_failure',
  'out_of_office',
  'auto_reply',
  'unknown'
] as const;
export type VerifiedEmailOutcome = (typeof VERIFIED_EMAIL_OUTCOMES)[number];

function compact(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Keep intent classification on the new reply, not on the quoted message that
 * Trevra itself sent. This is intentionally conservative rather than a full
 * email parser: if quote stripping is unsure, the result falls back to a normal
 * reply instead of manufacturing an unsubscribe or automatic-response state.
 */
export function stripQuotedReply(value: string | null | undefined): string {
  const lines = (value ?? '').replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>/.test(trimmed)) continue;
    if (/^On .+ wrote:$/i.test(trimmed)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break;
    if (/^From:\s.+$/i.test(trimmed) && kept.length > 0) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * The reply-intent patterns, shared with the LinkedIn reply classifier
 * (src/server/linkedin/reply-classification.ts) so both channels recognise the
 * same opt-out and absence wording. No `g` flag: `.test()` stays stateless.
 */
export const OPT_OUT_REPLY_PATTERN =
  /\b(?:unsubscribe|opt[ -]?out|remove me|take me off|stop (?:emailing|sending)|do not email|don't email|no more emails)\b/i;
export const OUT_OF_OFFICE_REPLY_PATTERN =
  /\b(?:out of (?:the )?office|currently away|away from (?:the )?office|on (?:annual )?leave|on vacation|returning (?:on|to the office)|limited access to email)\b/i;
export const AUTO_REPLY_PATTERN =
  /\b(?:automatic reply|automated reply|automated response|auto[ -]?reply|this is an automated message)\b/i;

export function classifyVerifiedInboundEmail(input: {
  subject?: string | null;
  body?: string | null;
  autoSubmitted?: string | null;
}): VerifiedEmailOutcome {
  const subject = compact(input.subject).toLowerCase();
  const body = compact(stripQuotedReply(input.body)).toLowerCase();
  const combined = `${subject}\n${body}`;
  const automatic =
    Boolean(compact(input.autoSubmitted)) && compact(input.autoSubmitted).toLowerCase() !== 'no';

  if (OPT_OUT_REPLY_PATTERN.test(body)) return 'unsubscribe';

  if (OUT_OF_OFFICE_REPLY_PATTERN.test(combined)) return 'out_of_office';

  if (automatic || AUTO_REPLY_PATTERN.test(combined)) return 'auto_reply';

  if (!body && !subject) return 'unknown';
  return 'reply';
}

export function classifyDeliveryFailure(input: {
  subject?: string | null;
  body?: string | null;
}): 'bounce' | 'delivery_failure' {
  const combined = `${compact(input.subject)}\n${compact(input.body)}`.toLowerCase();
  if (
    /\b(?:550\s+5\.1\.1|user unknown|unknown user|address not found|recipient address rejected|mailbox unavailable|mailbox does not exist|no such user|invalid recipient)\b/i.test(
      combined
    )
  )
    return 'bounce';
  return 'delivery_failure';
}
