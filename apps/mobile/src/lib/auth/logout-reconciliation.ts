import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  awaitActivityCleanupSettled,
  hasLogoutCleanupObligation,
  type LogoutCleanupRecord,
  readLogoutCleanupStore,
  writeLogoutCleanupRecords,
} from '@/lib/auth/logout-cleanup';
import { chainSave } from '@/lib/hooks/save-chain';
import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { LOGOUT_CLEANUP_TOMBSTONE_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

/**
 * Reconciliation for remote cleanup that failed at logout ("next authenticated
 * opportunity"). The `(app)` layout mounts the trigger: once `user.getMe` has
 * resolved and on each AppState return to `active` while authenticated.
 *
 * Each account owns its record, so an attempt reconciles only the records that
 * can belong to the signed-in account: its own and the identity-unknown one.
 * Records of other known accounts need their auth, which this session does not
 * have; they are left untouched and purged once older than the refresh-token
 * lifetime (30 days), which also bounds how long an id and device token are
 * held.
 *
 * The records are rewritten only when the auth epoch has not moved: a sign-out
 * or sign-in during the attempt owns them, so a stale reconciliation never
 * rewrites them. A storage failure keeps them for the next attempt instead of
 * surfacing an unhandled rejection.
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
  | { kind: 'different-user-retained' }
  | { kind: 'unreadable-store' }
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
  const epoch = currentAuthEpoch();
  // Serialize the whole read/cleanup/write attempt with scope-cleanup merges.
  // Capture auth before queueing so a later account change still fences it.
  attemptInFlight = chainSave(LOGOUT_CLEANUP_TOMBSTONE_KEY, async () => {
    const outcome = await runReconciliation(userId, epoch);
    return outcome;
  });
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

/**
 * True while a record that can belong to this session still needs an
 * activity-token unregister. A pending reconciliation retry owns those
 * recorded tokens, so a new session must not re-register them: the next
 * attempt would delete the new session's rows. This covers the spacing-skipped
 * case where `attemptLogoutReconciliation` made no new in-flight attempt to
 * await. Wait for scope cleanup to finish its write. A different known owner
 * cannot retry under this user's auth; unknown ownership remains conservative.
 */
export async function hasPendingActivityUnregister(userId: string | null): Promise<boolean> {
  await awaitActivityCleanupSettled();
  const read = await readLogoutCleanupStore();
  if (read.status === 'unreadable') {
    return false;
  }
  return read.records.some(
    record =>
      record.needsActivityUnregister &&
      (userId === null || record.userId === null || record.userId === userId)
  );
}

async function runReconciliation(
  userId: string,
  epoch: number
): Promise<ReconciliationAttemptOutcome> {
  const stored = await readLogoutCleanupStore();
  if (stored.status === 'unreadable') {
    // Nothing safe to retry or rewrite: keep the payload for a later read.
    return { kind: 'unreadable-store' };
  }
  const records = stored.records;
  const now = Date.now();
  const live = records.filter(record => now - record.failedAt <= TOMBSTONE_MAX_AGE_MS);
  const expiredPurged = live.length !== records.length;

  const owned = live.filter(record => record.userId === null || record.userId === userId);
  if (owned.length === 0) {
    if (!expiredPurged) {
      return live.length > 0 ? { kind: 'different-user-retained' } : { kind: 'no-tombstone' };
    }
    const persisted = await persistRecords(epoch, live);
    return { kind: persisted ? 'expired-discarded' : 'expired-retained' };
  }

  const outcomes = await Promise.all(
    owned.map(async record => {
      const reconciled = await reconcileRecord(record);
      return reconciled;
    })
  );
  const next: LogoutCleanupRecord[] = [];
  for (const record of live) {
    if (!owned.includes(record)) {
      next.push(record);
    }
  }
  for (const record of outcomes) {
    if (record !== null) {
      next.push(record);
    }
  }
  const allDone = outcomes.every(record => record === null);
  const persisted = await persistRecords(epoch, next);
  return { kind: 'attempted', tombstoneDeleted: persisted && allDone };
}

/**
 * Attempts every outstanding part of one record. Returns the record with its
 * remaining obligations, or null when nothing is left to retry.
 */
async function reconcileRecord(record: LogoutCleanupRecord): Promise<LogoutCleanupRecord | null> {
  const [push, activityDone] = await Promise.all([
    reconcilePushUnregister(record),
    reconcileActivityUnregister(record),
  ]);
  const next: LogoutCleanupRecord = {
    ...record,
    pushTokens: push.outstandingTokens,
    pushLookupPending: push.lookupPending,
    needsActivityUnregister: !activityDone,
    activityTokens: activityDone ? [] : record.activityTokens,
  };
  return hasLogoutCleanupObligation(next) ? next : null;
}

/**
 * Rewrites the records unless the auth epoch moved: a sign-out or sign-in
 * during the attempt owns them now, so a stale reconciliation must not touch
 * them.
 *
 * Never throws: a storage rejection keeps the records so the next attempt
 * retries them (the server treats the unregisters as idempotent). Returns
 * whether the rewrite landed.
 */
async function persistRecords(epoch: number, records: LogoutCleanupRecord[]): Promise<boolean> {
  if (!isCurrentAuthEpoch(epoch)) {
    return false;
  }
  try {
    await writeLogoutCleanupRecords(records);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts the outstanding push unregisters. A retryable failure (network,
 * 5xx, deadline) keeps the token or the pending lookup for the next attempt.
 */
async function reconcilePushUnregister(record: LogoutCleanupRecord): Promise<{
  lookupPending: boolean;
  outstandingTokens: string[];
}> {
  let lookupPending = record.pushLookupPending;
  if (lookupPending) {
    try {
      const outcome = await getDevicePushTokenOutcome();
      if (outcome.kind === 'token') {
        try {
          await trpcClient.user.unregisterPushToken.mutate({ token: outcome.token });
          lookupPending = false;
        } catch {
          // Retryable failure keeps the lookup pending.
        }
      } else if (outcome.kind === 'none') {
        // The device holds no token: nothing actionable, terminal for the
        // part (recorded residual, bounded by the 30-day expiry).
        lookupPending = false;
      }
      // 'lookup-failed' keeps the part for the next attempt.
    } catch {
      // Defensive: keeps the part.
    }
  }

  const settled = await Promise.all(
    record.pushTokens.map(async token => {
      try {
        await trpcClient.user.unregisterPushToken.mutate({ token });
        return { token, ok: true };
      } catch {
        return { token, ok: false };
      }
    })
  );
  return {
    lookupPending,
    outstandingTokens: settled.filter(entry => !entry.ok).map(entry => entry.token),
  };
}

/**
 * Attempts the outstanding activity-token unregisters recorded at logout.
 * Returns true when every recorded token unregistered. Only the record's
 * `activityTokens` are retried — never the current session's live tokens,
 * which a later sign-in re-registers under its own ownership. A retryable
 * failure keeps the part and the record.
 */
async function reconcileActivityUnregister(record: LogoutCleanupRecord): Promise<boolean> {
  if (!record.needsActivityUnregister || record.activityTokens.length === 0) {
    return true;
  }
  try {
    await Promise.all(
      record.activityTokens.map(async token => {
        await trpcClient.user.unregisterActivityToken.mutate({ token });
      })
    );
    return true;
  } catch {
    // Retryable failure keeps the part.
    return false;
  }
}
