type ShouldAnnounceOlderMessagesArrivalInputs = {
  wasInitialized: boolean;
  previousCount: number;
  nextCount: number;
  previousNewestKey: string | null;
  nextNewestKey: string | null;
};

/**
 * Whether assistive technology should hear that earlier messages arrived.
 *
 * Announces only on a real prepend after the list has already painted: count
 * grows while the newest item identity stays stable. Skips initial load,
 * appends (newest key changes), and empty prepends (count unchanged).
 */
export function shouldAnnounceOlderMessagesArrival({
  wasInitialized,
  previousCount,
  nextCount,
  previousNewestKey,
  nextNewestKey,
}: ShouldAnnounceOlderMessagesArrivalInputs): boolean {
  if (!wasInitialized) {
    return false;
  }
  if (nextCount <= previousCount) {
    return false;
  }
  if (previousNewestKey == null || nextNewestKey == null) {
    return false;
  }
  return previousNewestKey === nextNewestKey;
}

/** Screen-reader copy when an older page actually prepends items. */
export const OLDER_MESSAGES_ARRIVED_ANNOUNCEMENT = 'Earlier messages loaded';
