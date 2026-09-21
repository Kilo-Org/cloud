import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

/** Hard cap on the live rows offered — matches the stored page size bound. */
export const SHARE_DESTINATION_CAP = 30;

export type ShareDestinationRow = StoredSession & {
  live: boolean;
};

/**
 * Derive the share-gate destination list from the org-scoped stored page,
 * keeping only live sessions. A session that is not live cannot receive the
 * share, so it must never be offered as a destination. `activeSessionIds` is
 * the liveness filter — the stored rows stay the source of every field a row
 * renders, so an active id with no stored row is never invented.
 */
export function selectShareDestinations(
  storedSessions: readonly StoredSession[],
  activeSessionIds: ReadonlySet<string>
): ShareDestinationRow[] {
  const live: ShareDestinationRow[] = [];

  for (const session of storedSessions) {
    if (activeSessionIds.has(session.session_id)) {
      live.push({ ...session, live: true });
    }
  }

  return live.slice(0, SHARE_DESTINATION_CAP);
}
