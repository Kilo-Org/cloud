import { useEffect, useState } from 'react';

import {
  LIVE_SESSIONS_EMPTY_HOLD_MS,
  type LiveSessionsHold,
  resolveLiveSessionsHold,
} from '@/lib/live-sessions-render-hold';

function sameHold<T>(left: LiveSessionsHold<T> | null, right: LiveSessionsHold<T> | null): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  // The resolver passes a row array through unchanged, so identity is enough
  // and a new but equal decision does not cost another render.
  return (
    left.key === right.key &&
    left.emptySince === right.emptySince &&
    left.sessions === right.sessions
  );
}

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
 * without it a held emptiness would pin stale rows forever. Both values the
 * decision carries between renders are state, because React Compiler memoizes
 * render expressions against their traced inputs: a ref read or a
 * `performance.now()` call during render is untracked, so the render after the
 * timer would reuse the stale decision instead of releasing.
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
  // The previous decision is state, not a ref: a ref read during render is not
  // allowed, and a state value is a traced input that re-runs the decision.
  const [hold, setHold] = useState<LiveSessionsHold<T> | null>(null);
  // Monotonic, so a device clock correction cannot step the reading back and
  // stretch the window: `Date.now()` would hold the stale rows longer.
  const [now, setNow] = useState(() => performance.now());

  const resolved = resolveLiveSessionsHold({
    current,
    scopeKey,
    canHold,
    now,
    previousHold: hold,
  });

  useEffect(() => {
    setHold(previous => (sameHold(previous, resolved.hold) ? previous : resolved.hold));
  }, [resolved.hold]);

  const releaseDelayMs = resolved.releaseDelayMs;
  const emptySince = resolved.hold?.emptySince ?? null;
  // Written into the tracked clock when the timer fires, so the next decision
  // sees the window's end even with a frozen clock reading.
  const releaseAt = emptySince === null ? null : emptySince + LIVE_SESSIONS_EMPTY_HOLD_MS;

  useEffect(() => {
    if (releaseDelayMs === null || releaseAt === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setNow(releaseAt);
    }, releaseDelayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [releaseAt, releaseDelayMs]);

  return resolved.sessions;
}
