/**
 * Lease timing constants and helpers for the cloud-agent system.
 *
 * Leases are used to track ownership of execution resources.
 * A consumer must periodically renew its lease via heartbeats
 * to maintain exclusive access to an execution.
 */

// ---------------------------------------------------------------------------
// Timing Constants
// ---------------------------------------------------------------------------

/** Duration of a lease in milliseconds (90 seconds) */
export const LEASE_TTL_MS = 90_000;

/** Interval for heartbeat messages in milliseconds (30 seconds) */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Threshold for considering an execution stale (10 minutes) - used by reaper */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lease Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate when a lease should expire.
 *
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Unix timestamp when the lease expires
 */
export function calculateExpiry(now: number = Date.now()): number {
  return now + LEASE_TTL_MS;
}

/**
 * Check if a lease has expired.
 *
 * @param expiresAt - Lease expiry timestamp
 * @param now - Current timestamp (defaults to Date.now())
 * @returns true if the lease has expired
 */
export function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return now >= expiresAt;
}

/**
 * Check if an execution is stale and should be cleaned up by the reaper.
 * An execution is stale if it hasn't received a heartbeat in STALE_THRESHOLD_MS.
 *
 * @param lastHeartbeat - Timestamp of last heartbeat (undefined if never received)
 * @param now - Current timestamp (defaults to Date.now())
 * @returns true if the execution is stale
 */
export function isStale(lastHeartbeat: number | undefined, now: number = Date.now()): boolean {
  if (!lastHeartbeat) return true;
  return now - lastHeartbeat > STALE_THRESHOLD_MS;
}
