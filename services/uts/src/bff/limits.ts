/**
 * The per-handle limit of the browser-session API (design 3): each isolate lets one session handle
 * make at most 60 calls a minute across `read`, `token`, `end`, `end-all` and `devices/revoke`,
 * counted before the statement runs. The BFF calls UTS only when its cached session record is
 * missing or a token for the needed audience has under 2 minutes left (design 5.3), so a handle
 * that goes past 60 a minute is a loop or abuse; the answer is 429 `slow_down` with the seconds
 * until the window ends. The count is plain data in the isolate: a caller spread over many
 * isolates gets more, which the client assertion's single-use `jti` and the store bound.
 */
export const CALLS_PER_MINUTE_PER_HANDLE = 60;
const WINDOW_MS = 60_000;
/** The map holds at most this many windows; past it, the oldest window is dropped first. */
const MAX_HANDLES = 10_000;

export type HandleWindows = Map<string, { startedAt: number; count: number }>;

/** Null when one more call fits the handle's window (and counts it), else the `Retry-After`. */
export function handleRetryAfter(
  windows: HandleWindows,
  handleKey: string,
  now: number
): number | null {
  const held = windows.get(handleKey);
  if (held !== undefined && now - held.startedAt < WINDOW_MS) {
    if (held.count >= CALLS_PER_MINUTE_PER_HANDLE) {
      return Math.max(1, Math.ceil((held.startedAt + WINDOW_MS - now) / 1000));
    }
    held.count += 1;
    return null;
  }
  // A new window moves the handle to the end, so the first entry is always the oldest window.
  windows.delete(handleKey);
  windows.set(handleKey, { startedAt: now, count: 1 });
  if (windows.size > MAX_HANDLES) {
    const oldest = windows.keys().next();
    if (oldest.done !== true) windows.delete(oldest.value);
  }
  return null;
}
