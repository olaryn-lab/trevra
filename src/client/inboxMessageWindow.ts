/**
 * The inbox API returns stored messages in chronological order. Keep a long
 * conversation readable by revealing the newest page first, never hiding
 * messages from the stored record or changing its original ordering.
 */
export const INBOX_MESSAGE_PAGE = 50;

export function newestInboxMessages<T>(messages: readonly T[], limit: number): T[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const count = Math.min(messages.length, Math.floor(limit));
  return messages.slice(messages.length - count);
}

export function nextInboxMessageLimit(current: number, total: number): number {
  return Math.min(Math.max(0, total), Math.max(0, Math.floor(current)) + INBOX_MESSAGE_PAGE);
}

/** Different seats may contain the same LinkedIn thread URN. The persisted
 * Trevra thread id is the view identity, not the external conversation URN. */
export function inboxMessageLimitForThread(
  expanded: { threadId: string; limit: number } | null,
  threadId: string | null
): number {
  return expanded && threadId && expanded.threadId === threadId
    ? expanded.limit
    : INBOX_MESSAGE_PAGE;
}
