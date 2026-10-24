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

type PendingLoad = {
  /** The load answers for this user only; another user's id starts its own load. */
  userId: string;
  /** Assigned before the record is published, so a reader always finds it. */
  load?: Promise<boolean>;
};

const inFlight = new Map<string, PendingLoad>();

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

  const pending = inFlight.get(deviceSessionId);
  if (pending?.load !== undefined && pending.userId === kiloUserId) {
    return await pending.load;
  }

  const pendingLoad: PendingLoad = { userId: kiloUserId };
  const load = (async () => {
    const active = await loadActive();
    // A revocation during the read removes this load, so its answer may
    // predate the revocation. Return it to the caller that started before the
    // revocation, but never store it.
    if (inFlight.get(deviceSessionId) !== pendingLoad) return active;
    if (entries.size >= MAX_ENTRIES) prune(Date.now());
    entries.set(deviceSessionId, {
      userId: kiloUserId,
      active,
      expiresAt: Date.now() + DEVICE_SESSION_CACHE_TTL_MS,
    });
    return active;
  })();
  pendingLoad.load = load;
  inFlight.set(deviceSessionId, pendingLoad);

  try {
    return await load;
  } finally {
    if (inFlight.get(deviceSessionId) === pendingLoad) inFlight.delete(deviceSessionId);
  }
}

/**
 * Drop the cached answer for a session that was just revoked on this instance,
 * so the next request here sees the revocation without waiting for the TTL.
 * A load already running for that session is dropped too, so it cannot store
 * an answer computed before the revocation.
 */
export function invalidateDeviceSession(deviceSessionId: string): void {
  entries.delete(deviceSessionId);
  inFlight.delete(deviceSessionId);
}

export function resetDeviceSessionCacheForTest(): void {
  entries.clear();
  inFlight.clear();
}
