/**
 * Process-local cache of the active/inactive answer for one device session.
 *
 * Every bearer request whose credential names a device session has to know that
 * the session is still active. Reading the session row on each request puts a
 * primary-database round trip in front of the AI gateway's request path, which
 * runs in a different region from the primary. The answer is therefore cached
 * per instance for `DEVICE_SESSION_CACHE_TTL_MS`.
 *
 * Revocation delay: a revocation is enforced immediately on the instance that
 * writes it, through `invalidateDeviceSession`, and on every other instance,
 * including the other app, at most `DEVICE_SESSION_CACHE_TTL_MS` later, when the
 * entry expires and the next request reads the session again.
 *
 * A session created moments ago is unaffected: its first request misses the
 * cache and loads the row, so the row must be read from the primary.
 */
export const DEVICE_SESSION_CACHE_TTL_MS = 30_000;

/** Upper bound on cached sessions per instance. */
const MAX_ENTRIES = 10_000;

type CacheEntry = {
  /** The session belongs to this user, so another user's id is never served this answer. */
  userId: string;
  active: boolean;
  expiresAt: number;
};

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean>>();

function prune(now: number): void {
  for (const [sessionId, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(sessionId);
  }
  // Every entry is still fresh, so drop the oldest insertions.
  for (const sessionId of entries.keys()) {
    if (entries.size < MAX_ENTRIES) break;
    entries.delete(sessionId);
  }
}

/**
 * Whether the device session is active for this user, loading the answer
 * through `loadActive` when the cache holds no fresh entry for it.
 *
 * Callers pass the primary-database check as `loadActive`. A rejected load is
 * not cached and propagates, so a database failure stays a failure instead of
 * becoming an authorization decision.
 */
export async function isDeviceSessionActive(
  deviceSessionId: string,
  kiloUserId: string,
  loadActive: () => Promise<boolean>
): Promise<boolean> {
  const now = Date.now();
  const entry = entries.get(deviceSessionId);
  if (entry !== undefined && entry.userId === kiloUserId && entry.expiresAt > now) {
    return entry.active;
  }

  // Concurrent requests for one session share a load. The key includes the
  // user, so a request naming another user's session never receives that
  // user's answer.
  const inFlightKey = `${kiloUserId}:${deviceSessionId}`;
  const pending = inFlight.get(inFlightKey);
  if (pending !== undefined) {
    return await pending;
  }

  const load = (async () => {
    const active = await loadActive();
    if (entries.size >= MAX_ENTRIES) prune(Date.now());
    entries.set(deviceSessionId, {
      userId: kiloUserId,
      active,
      expiresAt: Date.now() + DEVICE_SESSION_CACHE_TTL_MS,
    });
    return active;
  })();

  inFlight.set(inFlightKey, load);
  try {
    return await load;
  } finally {
    inFlight.delete(inFlightKey);
  }
}

/**
 * Drop the cached answer for a session that was just revoked on this instance,
 * so the next request here sees the revocation without waiting for the TTL.
 */
export function invalidateDeviceSession(deviceSessionId: string): void {
  entries.delete(deviceSessionId);
}

export function resetDeviceSessionCacheForTest(): void {
  entries.clear();
  inFlight.clear();
}
