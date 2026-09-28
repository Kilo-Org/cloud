import { useEffect, useRef, useState } from 'react';

import { type LiveSessionsHold, resolveLiveSessionsHold } from '@/lib/live-sessions-render-hold';

/**
 * Holds the live (socket-fed) rows through a transient empty live set.
 *
 * The socket writers (a `sessions.list` snapshot, a `sessions.heartbeat`,
 * `cli.disconnected`) take rows away the moment a CLI socket blips, and the
 * reconnect restores them a moment later: rendering that gap shows the empty
 * state and then the rows again. This hook keeps the last non-empty rows on
 * screen for the short window the reconnect needs (see
 * `resolveLiveSessionsHold`), and releases the surface to the empty state once
 * the window expires so a finished session is still reported as empty.
 *
 * The release is a timer because nothing else re-renders at the window's end:
 * without it a held emptiness would pin stale rows forever.
 */
export function useLiveSessionsHold<T>(input: {
  /** Live rows for the current context (empty while the socket state is empty). */
  current: T[];
  /** Stable identity of the query the rows belong to. */
  scopeKey: string;
  /** False when the caller may not read (signed out, not ready): never hold. */
  canHold: boolean;
}): T[] {
  const { current, scopeKey, canHold } = input;
  const holdRef = useRef<LiveSessionsHold<T> | null>(null);
  // Bumped when the window expires so the hold decision runs again.
  const [, setRelease] = useState(0);

  const resolved = resolveLiveSessionsHold({
    current,
    scopeKey,
    canHold,
    // Monotonic, so a device clock correction cannot step the reading back and
    // stretch the window: `Date.now()` would hold the stale rows longer.
    now: performance.now(),
    previousHold: holdRef.current,
  });

  useEffect(() => {
    holdRef.current = resolved.hold;
  }, [resolved.hold]);

  const releaseDelayMs = resolved.releaseDelayMs;
  useEffect(() => {
    if (releaseDelayMs === null) {
      return undefined;
    }
    // The delay shrinks as renders arrive inside the window; the last armed
    // timer fires at the window's end and releases the hold.
    const timer = setTimeout(() => {
      setRelease(count => count + 1);
    }, releaseDelayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [releaseDelayMs]);

  return resolved.sessions;
}
