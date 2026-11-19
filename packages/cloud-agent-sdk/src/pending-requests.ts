/**
 * FIFO upsert for the request-keyed pending interaction lists (questions,
 * permissions, unreadable permissions).
 *
 * A repeat of the same request replaces the entry in place — the wrapper
 * replays pending requests after a snapshot, and a replay must not enqueue a
 * duplicate card. A new request goes to the back, so the oldest pending
 * request is always the head.
 */
export function upsertByKey<T>(
  list: readonly T[],
  next: T,
  keyOf: (entry: T) => string
): readonly T[] {
  const key = keyOf(next);
  const index = list.findIndex(entry => keyOf(entry) === key);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

/** The `requestId` lists: unreadable permission notices. */
export function upsertByRequestId<T extends { requestId: string }>(
  list: readonly T[],
  next: T
): readonly T[] {
  return upsertByKey(list, next, entry => entry.requestId);
}
