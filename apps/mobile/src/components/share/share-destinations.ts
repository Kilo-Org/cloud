import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

/** Hard cap after live hoist — matches the stored page size bound. */
export const SHARE_DESTINATION_CAP = 30;

export type ShareDestinationRow = StoredSession & {
  live: boolean;
};

/**
 * Derive the share-gate destination list from the org-scoped stored page.
 * `activeSessionIds` is used only to mark and hoist live rows — never as a
 * source of rows (activeSessions.list has no organizationId filter).
 */
export function selectShareDestinations(
  storedSessions: readonly StoredSession[],
  activeSessionIds: ReadonlySet<string>
): ShareDestinationRow[] {
  const live: ShareDestinationRow[] = [];
  const rest: ShareDestinationRow[] = [];

  for (const session of storedSessions) {
    const row: ShareDestinationRow = {
      ...session,
      live: activeSessionIds.has(session.session_id),
    };
    if (row.live) {
      live.push(row);
    } else {
      rest.push(row);
    }
  }

  return [...live, ...rest].slice(0, SHARE_DESTINATION_CAP);
}
