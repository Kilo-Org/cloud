/**
 * Pure derivation of the targets the OS launcher surfaces open: Android app
 * shortcuts on the launcher icon, iOS Home Screen Quick Actions, and the
 * Android quick-settings tile. The native surfaces in later slices import
 * these values directly, so this module stays free of React, native modules,
 * and i18n.
 *
 * Every target is a `kiloapp://` URL that `resolveIncomingUrl` maps onto the
 * same Expo Router route the matching in-app control pushes — the launcher
 * adds no routing of its own, only entry points.
 */

import { parseTimestamp } from '@kilocode/app-shared/utils';

/**
 * Prefix for a single session's deep link: alone it resolves to the Agents
 * tab, with an id to `/(app)/agent-chat/<id>`.
 */
export const LAUNCHER_SESSION_URL_PREFIX = 'kiloapp:///cloud/sessions';

/** Resolves to `/(app)/agent-chat/new`, the route the New agent FAB pushes. */
export const LAUNCHER_NEW_AGENT_URL = 'kiloapp:///cloud/sessions/new';

/**
 * Deep link for one session, resolving to `/(app)/agent-chat/<id>`.
 * The id is encoded so an id containing `/`, `?`, or a space stays a single
 * path segment and the `/cloud/sessions/*` row still matches.
 */
export function launcherSessionUrl(sessionId: string): string {
  return `${LAUNCHER_SESSION_URL_PREFIX}/${encodeURIComponent(sessionId)}`;
}

export type LauncherSurfaceTargets = {
  /** Always present: the New agent shortcut/tile fallback. */
  newAgentUrl: string;
  /** The longest-waiting session, or null when nothing waits. */
  needsInputUrl: string | null;
  /** The last session the user opened, or null when there is none. */
  openLastSessionUrl: string | null;
};

type WaitingSession = { id: string; waitedSince: number };

/**
 * The sort key for one waiting session. `statusUpdatedAt` is the server's raise
 * timestamp, so an earlier stamp means a longer wait. A row without a usable
 * stamp reports `Number.POSITIVE_INFINITY`: `longestWaiting` picks the smallest
 * `waitedSince`, so "unknown" must be the largest value, never 0 (the minimum),
 * or a timestamp-less row would always outrank a row with a real wait.
 */
export function waitedSinceFor(statusUpdatedAt: string | null | undefined): number {
  if (!statusUpdatedAt) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = parseTimestamp(statusUpdatedAt).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Longest wait first: the smallest `waitedSince` (an epoch-ms timestamp, or
 * `POSITIVE_INFINITY` for a session with no usable raise timestamp) is the
 * session that has waited the longest. Ties keep input order.
 */
function longestWaiting(waiting: readonly WaitingSession[]): WaitingSession | null {
  let oldest: WaitingSession | null = null;

  for (const candidate of waiting) {
    if (oldest === null || candidate.waitedSince < oldest.waitedSince) {
      oldest = candidate;
    }
  }

  return oldest;
}

/**
 * The three targets in the same shape on both platforms. `newAgentUrl` is
 * always present; Needs input and Open last session are absent (null) when
 * they have nothing to open, which is what makes Needs input dynamic.
 */
export function deriveLauncherTargets(input: {
  waiting: readonly { id: string; waitedSince: number }[];
  lastOpenedSessionId: string | null;
}): LauncherSurfaceTargets {
  const oldest = longestWaiting(input.waiting);
  const lastOpenedSessionId = input.lastOpenedSessionId;

  return {
    newAgentUrl: LAUNCHER_NEW_AGENT_URL,
    needsInputUrl: oldest === null ? null : launcherSessionUrl(oldest.id),
    openLastSessionUrl:
      lastOpenedSessionId === null || lastOpenedSessionId === ''
        ? null
        : launcherSessionUrl(lastOpenedSessionId),
  };
}
