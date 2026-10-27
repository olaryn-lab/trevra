import type { DueLinkedInAction } from './local-worker.js';

type FollowUp = Pick<
  DueLinkedInAction,
  'id' | 'kind' | 'campaignId' | 'manual' | 'replyToInbound' | 'targetRef'
>;

/** Only autonomous managed follow-ups need a fresh inbox read. */
export function needsLinkedInReplyPreflight(action: FollowUp): boolean {
  return Boolean(
    action.campaignId &&
    !action.manual &&
    !action.replyToInbound &&
    (action.kind === 'dm' || action.kind === 'inmail' || action.kind === 'reply')
  );
}

/**
 * Read a bounded section of the real inbox BEFORE a managed follow-up's
 * ordinary safety gate. The runner re-reads the member's DB reply state after
 * this hook: replies ingested by the read can retire obsolete follow-ups.
 *
 * A failed inbox access cannot be interpreted as "no reply". Do not stamp a
 * failed read as fresh; the next sitting can retry under normal pacing.
 * The fresh-read cache lives only for this sitting, never across processes.
 */
export interface ReplyPreflightEvidence {
  blocked: string | null;
  degraded: readonly string[];
  /** This particular person's transcript was opened and ingested. */
  recipientVerified: boolean;
  /** A previous outbound message might have received a reply. */
  priorOutboundEvidence: boolean;
}

export function createLinkedInReplyPreflight(
  readInbox: (action: FollowUp) => Promise<ReplyPreflightEvidence>,
  options: { now?: () => Date; maxAgeMs?: number } = {}
): (action: FollowUp) => Promise<void> {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  const verifiedByTarget = new Map<string, number>();
  return async (action) => {
    if (!needsLinkedInReplyPreflight(action)) return;
    const instant = now().getTime();
    const key = action.targetRef.trim().toLowerCase();
    const lastVerifiedAt = verifiedByTarget.get(key);
    if (
      lastVerifiedAt !== undefined &&
      instant >= lastVerifiedAt &&
      instant - lastVerifiedAt < maxAgeMs
    )
      return;
    let result: ReplyPreflightEvidence;
    try {
      result = await readInbox(action);
    } catch {
      throw new Error('Could not refresh LinkedIn replies; automated follow-ups remain queued.');
    }
    if (result.blocked)
      throw new Error(
        'LinkedIn reply verification was blocked; automated follow-ups remain queued.'
      );
    // Linkage and metadata warnings do not prove the message read was wrong.
    // A conversation which was not read might contain a reply, though.
    if (
      result.degraded.some((detail) =>
        /could not be read\s*\(|selector.drift|limit.wall|checkpoint/i.test(detail)
      )
    )
      throw new Error(
        'A LinkedIn conversation could not be verified; automated follow-ups remain queued.'
      );
    // A bounded inbox scan is not proof that a specific prospect's messages
    // were read. After any previous outgoing message, require an actually
    // opened conversation; otherwise a hidden/older reply could trigger an
    // automated follow-up. First approved messages (no prior outbound message)
    // can proceed without a pre-existing LinkedIn conversation.
    if (!result.recipientVerified && result.priorOutboundEvidence)
      throw new Error(
        'The recipient conversation was not verified; automated follow-ups remain queued.'
      );
    // An approved FIRST message without a thread is permitted once, but
    // must not grant 15 minutes of cached reply-freshness. That first send
    // changes the situation: the very next action may now have a reply.
    if (result.recipientVerified) verifiedByTarget.set(key, now().getTime());
  };
}
