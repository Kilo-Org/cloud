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
 * different known user the record is discarded without a network call,
 * because the unregister needs an auth no later session has.
 *
 * The tombstone is deleted only when the auth epoch has not moved: a sign-out
 * or sign-in during the attempt owns the record, so a stale reconciliation
 * never deletes it. A deletion storage failure keeps the tombstone for the
 * next attempt instead of surfacing an unhandled rejection.
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
  | { kind: 'different-user-discarded' }
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

/**
 * Awaits the in-flight logout reconciliation attempt, if any, without
 * throwing. Callers that must not race the unregister (push-token
 * registration) trigger `attemptLogoutReconciliation` first and then await
 * this, so registration cannot start until any in-flight unregister for the
 * current sign-in has settled.
 */
export async function awaitLogoutReconciliationSettled(): Promise<void> {
  if (attemptInFlight) {
    await attemptInFlight;
  }
}

async function runReconciliation(userId: string): Promise<ReconciliationAttemptOutcome> {
  const epoch = currentAuthEpoch();
  const tombstone = await readLogoutCleanupTombstone();
  if (!tombstone) {
    return { kind: 'no-tombstone' };
  }
  if (Date.now() - tombstone.failedAt > TOMBSTONE_MAX_AGE_MS) {
    const deleted = await deleteTombstone(epoch);
    return deleted ? { kind: 'expired-discarded' } : { kind: 'expired-retained' };
  }
  if (tombstone.userId !== null && tombstone.userId !== userId) {
    // Different known user: the unregister needs their auth, which no later
    // session has, so it can never run. Discard the record instead of holding
    // their user id and push token in the keychain, which on iOS survives
    // app deletion.
    await deleteTombstone(epoch);
    return { kind: 'different-user-discarded' };
  }

  const allDone = await reconcilePushUnregister(tombstone);
  if (allDone) {
    const deleted = await deleteTombstone(epoch);
    return { kind: 'attempted', tombstoneDeleted: deleted };
  }
  return { kind: 'attempted', tombstoneDeleted: false };
}

/**
 * Deletes the tombstone unless the auth epoch moved: a sign-out or sign-in
 * during the attempt owns the record now, so a stale reconciliation must not
 * remove it.
 *
 * Never throws: a storage rejection keeps the tombstone so the next attempt
 * retries. Returns whether the tombstone was deleted.
 */
async function deleteTombstone(epoch: number): Promise<boolean> {
  if (!isCurrentAuthEpoch(epoch)) {
    return false;
  }
  try {
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
