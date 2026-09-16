/**
 * Pure render-hold decision for the live (socket-fed) Agents list.
 *
 * The live set is written by four independent sources: the tRPC poll, a
 * `sessions.list` snapshot, a `sessions.heartbeat`, and `cli.disconnected`.
 * The socket-fed writes carry no server-confirmed emptiness — a CLI socket
 * that drops and reconnects (network blip, laptop sleep, DO restart) removes
 * every row of that connection for as long as the reconnect takes, and a
 * mobile socket reconnect can answer with an empty snapshot while no CLI
 * socket has re-registered yet. The rows come back a moment later, so the
 * surface rendered `rows → empty → rows`: the reported blank flash.
 *
 * An emptiness that follows a non-empty live set is therefore held for
 * `LIVE_SESSIONS_EMPTY_HOLD_MS`: the last non-empty rows keep rendering, and
 * rows delivered inside the window retire the hold immediately (the reconnect
 * case, with no visible transition at all). The window is time-boxed rather
 * than tied to the next server answer, because the refresh that follows a
 * disconnect reads the same transiently empty live set; once it expires the
 * empty state appears, so a genuinely finished session is still reported as
 * empty and no stale rows are pinned forever. The window is measured on a
 * monotonic reading, so a device clock correction cannot stretch it; a reading
 * behind the recorded start restarts the window instead.
 *
 * The hold is scoped to the query key: a context (personal/organization)
 * change builds a new key and must keep its designed loading state instead of
 * showing the previous context's rows.
 */

/** How long a socket-emptied live set keeps rendering its last rows. */
export const LIVE_SESSIONS_EMPTY_HOLD_MS = 5000;

export type LiveSessionsHold<T> = {
  /** Query key the held rows belong to. */
  key: string;
  /** Last non-empty rows to keep rendering while the live set is empty. */
  sessions: T[];
  /**
   * Monotonic clock reading when the live set first went empty inside this
   * hold, or null while rows are being delivered.
   */
  emptySince: number | null;
};

type ResolvedLiveSessionsHold<T> = {
  /** Rows to render: the live rows, or the held rows through the window. */
  sessions: T[];
  /** Hold to carry into the next render, or null when there is none. */
  hold: LiveSessionsHold<T> | null;
  /** Milliseconds until the held emptiness must release, or null. */
  releaseDelayMs: number | null;
};

export function resolveLiveSessionsHold<T>(input: {
  /** Live rows for the current context (empty while the socket state is empty). */
  current: T[];
  /** Stable identity of the query the rows belong to. */
  scopeKey: string;
  /** False when the caller may not read (signed out, not ready): never hold. */
  canHold: boolean;
  /** Monotonic clock reading for this render. */
  now: number;
  /** Hold carried from the previous render, or null. */
  previousHold: LiveSessionsHold<T> | null;
}): ResolvedLiveSessionsHold<T> {
  const { current, scopeKey, canHold, now, previousHold } = input;
  if (current.length > 0) {
    return {
      sessions: current,
      hold: { key: scopeKey, sessions: current, emptySince: null },
      releaseDelayMs: null,
    };
  }
  if (!canHold || previousHold?.key !== scopeKey || previousHold.sessions.length === 0) {
    return { sessions: current, hold: null, releaseDelayMs: null };
  }
  // A reading behind the recorded one means the caller's clock stepped
  // backwards (an NTP correction, a manual clock change): start the window
  // over from here instead of letting the step stretch it past its end.
  const emptySince =
    previousHold.emptySince !== null && previousHold.emptySince <= now
      ? previousHold.emptySince
      : now;
  const elapsedMs = now - emptySince;
  if (elapsedMs >= LIVE_SESSIONS_EMPTY_HOLD_MS) {
    return { sessions: current, hold: null, releaseDelayMs: null };
  }
  return {
    sessions: previousHold.sessions,
    hold: { key: scopeKey, sessions: previousHold.sessions, emptySince },
    releaseDelayMs: LIVE_SESSIONS_EMPTY_HOLD_MS - elapsedMs,
  };
}
