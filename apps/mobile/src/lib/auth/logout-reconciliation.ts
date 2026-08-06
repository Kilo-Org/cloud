import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  deleteLogoutCleanupTombstone,
  isNotFoundTrpcError,
  type LogoutCleanupTombstone,
  readLogoutCleanupTombstone,
} from '@/lib/auth/logout-cleanup';
import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { trpcClient } from '@/lib/trpc';

/**
 * Reconciliation for failed remote logout cleanup ("next authenticated
 * opportunity"). The `(app)` layout mounts the trigger: once `user.getMe` has
 * resolved and on each AppState return to `active` while authenticated.
 *
 * A tombstone older than the refresh-token lifetime (30 days) is discarded
 * without a network call: the orphaned session is unusable past it. For a
 * current user the outstanding parts are retried and completed parts are
 * never repeated; for a different known user nothing is attempted.
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
    // Different known user: no attempt. Their token cannot revoke the prior
    // user's session; the tombstone stays until ownership or the 30-day
    // expiry removes it. Residual risk is bounded: the prior refresh token
    // was destroyed locally and its access token expires within 1 h.
    return { kind: 'different-user-skipped' };
  }

  const allDone = await reconcileOutstandingParts(tombstone);
  if (allDone) {
    const deleted = await deleteTombstoneIfUnchanged(tombstone, epoch);
    return { kind: 'attempted', tombstoneDeleted: deleted };
  }
  return { kind: 'attempted', tombstoneDeleted: false };
}

function tombstonesEqual(a: LogoutCleanupTombstone, b: LogoutCleanupTombstone): boolean {
  return (
    a.userId === b.userId &&
    a.deviceSessionId === b.deviceSessionId &&
    a.pushToken === b.pushToken &&
    a.needsSessionRevoke === b.needsSessionRevoke &&
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
 * Attempts exactly the outstanding parts. Returns true when every part is
 * done. A part is done only on a server-authoritative completion; retryable
 * failures (network, 5xx, deadline) keep the part and the tombstone.
 */
async function reconcileOutstandingParts(tombstone: LogoutCleanupTombstone): Promise<boolean> {
  let sessionDone = !tombstone.needsSessionRevoke;
  let pushDone = !tombstone.needsPushUnregister;

  if (tombstone.needsSessionRevoke) {
    if (tombstone.deviceSessionId === null) {
      // A null id is terminal: nothing actionable.
      sessionDone = true;
    } else {
      try {
        await trpcClient.user.revokeDeviceSessionById.mutate({
          sessionId: tombstone.deviceSessionId,
        });
        // A resolved mutate is authoritative: NOT_FOUND throws, and the only
        // other outcomes ('revoked', 'already_revoked') complete the part.
        sessionDone = true;
      } catch (error) {
        // The owner's NOT_FOUND is authoritative (missing or already gone).
        // For an identity-unknown tombstone NOT_FOUND is ambiguous (missing
        // vs. owned by someone else), so it is NOT terminal there.
        if (tombstone.userId !== null && isNotFoundTrpcError(error)) {
          sessionDone = true;
        }
      }
    }
  }

  if (tombstone.needsPushUnregister) {
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
          pushDone = true;
        }
        // 'lookup-failed' keeps the part for the next attempt.
      } catch {
        // Defensive: keeps the part.
      }
    }
    if (pushToken !== null) {
      try {
        await trpcClient.user.unregisterPushToken.mutate({ token: pushToken });
        pushDone = true;
      } catch {
        // Retryable failure keeps the part.
      }
    }
  }

  return sessionDone && pushDone;
}
