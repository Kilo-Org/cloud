/**
 * FIFO upsert for the request-ID-keyed pending interaction lists (questions,
 * permissions, unreadable permissions).
 *
 * A repeat of the same requestId replaces the entry in place — the wrapper
 * replays pending requests after a snapshot, and a replay must not enqueue a
 * duplicate card. A new requestId goes to the back, so the oldest pending
 * request is always the head.
 */
export function upsertByRequestId<T extends { requestId: string }>(
  list: readonly T[],
  next: T
): readonly T[] {
  const index = list.findIndex(entry => entry.requestId === next.requestId);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}
