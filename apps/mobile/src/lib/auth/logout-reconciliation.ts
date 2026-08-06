import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  deleteLogoutCleanupTombstone,
  type LogoutCleanupTombstone,
  readLogoutCleanupTombstone,
} from '@/lib/auth/logout-cleanup';
import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { trpcClient } from '@/lib/trpc';

/**
 * Reconciliation for a failed push-token unregister ("next authenticated
 * opportunity"). The `(app)` layout mounts the trigger: once `user.getMe` has
 * resolved and on each AppState return to `active` while authenticated.
 *
 * A tombstone older than the refresh-token lifetime (30 days) is discarded
 * without a network call. For a current user the unregister is retried; for a
 * different known user nothing is attempted.
 *
 * The tombstone is deleted only when the attempt is still authoritative: the
 * auth epoch has not moved (no sign-out or sign-in advanced it) and the
 * persisted record still equals the one this attempt reconciled. A
 * sign-out cleanup that rewrote or deleted the tombstone mid-attempt is never
 * undone by a stale reconciliation, and a deletion storage failure keeps the
 * tombstone for the next attempt instead of surfacing an unhandled rejection.
 */

const MIN_ATTEMPT_SPACING_MS = 60_000;
export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let attemptInFlight: Promise<ReconciliationAttemptOutcome> | null = null;
let lastAttemptAtMs = 0;

export type ReconciliationAttemptOutcome =
  | { kind: 'in-flight' }
  | { kind: 'spacing-skipped' }
  | { kind: 'no-tombstone' }
  | { kind: 'expired-discarded' }
  | { kind: 'expired-retained' }
  | { kind: 'different-user-skipped' }
  | { kind: 'attempted'; tombstoneDeleted: boolean };

/** Test-only: clears the single-flight and spacing state between tests. */
export function resetLogoutReconciliationForTests(): void {
  attemptInFlight = null;
  lastAttemptAtMs = 0;
}

/**
 * Single-flight, minimum-60s-spaced reconciliation attempt for `userId`.
 * Returns the in-flight outcome when an attempt is already running, and skips
 * without any network call when one ran within the spacing window — so
 * foreground flaps do not hammer the server and a transient failure retries on
 * the next foreground without waiting for a remount.
 */
export async function attemptLogoutReconciliation(
  userId: string
): Promise<ReconciliationAttemptOutcome> {
  if (attemptInFlight) {
    return { kind: 'in-flight' };
  }
  const now = Date.now();
  if (now - lastAttemptAtMs < MIN_ATTEMPT_SPACING_MS) {
    return { kind: 'spacing-skipped' };
  }
  lastAttemptAtMs = now;
  attemptInFlight = runReconciliation(userId);
  try {
    return await attemptInFlight;
  } finally {
    attemptInFlight = null;
  }
}

async function runReconciliation(userId: string): Promise<ReconciliationAttemptOutcome> {
  const epoch = currentAuthEpoch();
  const tombstone = await readLogoutCleanupTombstone();
  if (!tombstone) {
    return { kind: 'no-tombstone' };
  }
  if (Date.now() - tombstone.failedAt > TOMBSTONE_MAX_AGE_MS) {
    const deleted = await deleteTombstoneIfUnchanged(tombstone, epoch);
    return deleted ? { kind: 'expired-discarded' } : { kind: 'expired-retained' };
  }
  if (tombstone.userId !== null && tombstone.userId !== userId) {
    // Different known user: no attempt. The tombstone stays until ownership
    // or the 30-day expiry removes it.
    return { kind: 'different-user-skipped' };
  }

  const allDone = await reconcilePushUnregister(tombstone);
  if (allDone) {
    const deleted = await deleteTombstoneIfUnchanged(tombstone, epoch);
    return { kind: 'attempted', tombstoneDeleted: deleted };
  }
  return { kind: 'attempted', tombstoneDeleted: false };
}

function tombstonesEqual(a: LogoutCleanupTombstone, b: LogoutCleanupTombstone): boolean {
  return (
    a.userId === b.userId &&
    a.pushToken === b.pushToken &&
    a.needsPushUnregister === b.needsPushUnregister &&
    a.failedAt === b.failedAt
  );
}

/**
 * Deletes the tombstone only when the attempt is still authoritative: the
 * auth epoch has not moved (no sign-out or sign-in advanced it) and the
 * persisted tombstone still equals the one this attempt reconciled. A
 * sign-out cleanup that rewrote or deleted the tombstone mid-attempt must
 * never be undone by a stale reconciliation.
 *
 * Never throws: a storage rejection keeps the tombstone so the next attempt
 * retries. Returns whether the tombstone is gone afterwards (it can already
 * be gone when a concurrent sign-out cleanup deleted it). SecureStore has no
 * compare-and-delete, so a tombstone written in the window between the
 * verify-read and the delete could still be removed; that loss is bounded by
 * the accepted residual for a lost tombstone (the orphaned session stays
 * revocable server-side until its refresh token expires).
 */
async function deleteTombstoneIfUnchanged(
  expected: LogoutCleanupTombstone,
  epoch: number
): Promise<boolean> {
  if (!isCurrentAuthEpoch(epoch)) {
    return false;
  }
  try {
    const current = await readLogoutCleanupTombstone();
    if (current === null) {
      return true;
    }
    if (!tombstonesEqual(current, expected)) {
      return false;
    }
    await deleteLogoutCleanupTombstone();
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts the outstanding push unregister. Returns true when it is done. A
 * retryable failure (network, 5xx, deadline) keeps the part and the tombstone.
 */
async function reconcilePushUnregister(tombstone: LogoutCleanupTombstone): Promise<boolean> {
  if (!tombstone.needsPushUnregister) {
    return true;
  }

  let pushToken = tombstone.pushToken;
  if (pushToken === null) {
    // The device push token is stable per device: re-read what the device
    // holds now and unregister that value.
    try {
      const outcome = await getDevicePushTokenOutcome();
      if (outcome.kind === 'token') {
        pushToken = outcome.token;
      } else if (outcome.kind === 'none') {
        // The device holds no token: nothing actionable, terminal for the
        // part (recorded residual, bounded by the 30-day expiry).
        return true;
      }
      // 'lookup-failed' keeps the part for the next attempt.
    } catch {
      // Defensive: keeps the part.
    }
  }
  if (pushToken === null) {
    return false;
  }
  try {
    await trpcClient.user.unregisterPushToken.mutate({ token: pushToken });
    return true;
  } catch {
    // Retryable failure keeps the part.
    return false;
  }
}
