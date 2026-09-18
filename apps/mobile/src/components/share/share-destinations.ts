import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

/** Hard cap on the live destination list — matches the stored page size bound. */
export const SHARE_DESTINATION_CAP = 30;

export type ShareDestinationRow = StoredSession & {
  live: boolean;
};

/**
 * Derive the share-gate destination list from the org-scoped stored page.
 * Only live sessions are destinations: a row is listed when its session id
 * is in `activeSessionIds`, so sessions that are not live never appear.
 * Stored order (updated_at desc) is preserved; `activeSessionIds` is an
 * id lookup, never a source of rows (a live id with no stored row is not
 * rendered).
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
