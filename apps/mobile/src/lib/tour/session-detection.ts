import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';

/**
 * Pure session detection for the first-sign-in tour. No React, no network.
 *
 * The tour proves a session was created THROUGH the tour, so a session that
 * already existed when the tour captured its baseline never counts. Only a
 * row that appears after the baseline, on the path the person chose, matches.
 */

/** Which path of the tour a session must belong to. */
export type TourSessionKind = 'cloud' | 'remote';

/** Minimal structural shape read from the active-sessions cache. */
export type TourSession = {
  id: string;
  connectionId?: string;
};

/** Session ids present when the tour started; these never count as new. */
export function captureSessionBaseline(sessions: readonly TourSession[]): Set<string> {
  return new Set(sessions.map(session => session.id));
}

/**
 * True when `sessions` holds a session created after the baseline on the
 * chosen path.
 *
 * - `'cloud'`: the row's `connectionId` is the cloud-agent sentinel.
 * - `'remote'`: the row's `connectionId` is a real CLI id (never the
 *   sentinel); when `connectionId` is passed it must match that instance.
 *
 * Any id present in `baselineIds` is ignored, so a pre-existing session can
 * never satisfy the check.
 */
export function hasNewSession({
  sessions,
  baselineIds,
  kind,
  connectionId,
}: {
  sessions: readonly TourSession[];
  baselineIds: ReadonlySet<string>;
  kind: TourSessionKind;
  connectionId?: string;
}): boolean {
  return sessions.some(session => {
    if (baselineIds.has(session.id)) {
      return false;
    }
    if (kind === 'cloud') {
      return session.connectionId === CLOUD_AGENT_CONNECTION_ID;
    }
    if (!session.connectionId || session.connectionId === CLOUD_AGENT_CONNECTION_ID) {
      return false;
    }
    return connectionId === undefined || session.connectionId === connectionId;
  });
}
