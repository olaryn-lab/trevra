/**
 * A refresh while page 2+ is open must update existing threads, not append
 * duplicate DOM rows. Data can move between offset windows after a sync; keep
 * the first observed position and use the latest returned content per URN.
 */
export function mergeInboxSearchPage<T extends { threadUrn: string }>(
  current: readonly T[],
  incoming: readonly T[],
  page: number
): T[] {
  if (page <= 0) return [...incoming];
  const byUrn = new Map(current.map((thread) => [thread.threadUrn, thread] as const));
  for (const thread of incoming) byUrn.set(thread.threadUrn, thread);
  return [...byUrn.values()];
}
