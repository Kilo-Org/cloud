import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';

import { deviceSessionIdFromToken } from '@/lib/auth/device-session-claim';
import { getActiveToken } from '@/lib/auth/token-owner';
import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { readCachedUserId } from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { LOGOUT_CLEANUP_TOMBSTONE_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

/**
 * Safe-retry tombstone for failed remote logout cleanup (DEC-01). Exactly ONE
 * pending cleanup is supported: a later failed logout overwrites an earlier
 * tombstone (recorded accepted limitation — the overwritten account's refresh
 * token was already destroyed locally and its access token expires within 1 h).
 *
 * The tombstone is written directly with `SecureStore.setItemAsync`,
 * deliberately NOT epoch-fenced: it must survive sign-out by design, and
 * sign-out must never delete it.
 */
export type LogoutCleanupTombstone = {
  /** getMe cache identity at logout, or null when the query had not resolved. */
  userId: string | null;
  /** `deviceSessionId` claim from the access token, or null when absent. */
  deviceSessionId: string | null;
  /** Device push token at logout; null when lookup failed or permission missing. */
  pushToken: string | null;
  needsSessionRevoke: boolean;
  needsPushUnregister: boolean;
  /** Epoch ms of the failed logout; reconciliation discards past 30 days. */
  failedAt: number;
};

/** A tRPC rejection whose error code is NOT_FOUND (either surface). */
export function isNotFoundTrpcError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; data?: { code?: unknown } };
  return candidate.code === 'NOT_FOUND' || candidate.data?.code === 'NOT_FOUND';
}

/**
 * Runtime guard for a persisted tombstone. Every field is validated so a
 * malformed record is discarded instead of being interpreted as a
 * different-user skip or driving unsafe remote cleanup.
 */
function isLogoutCleanupTombstone(value: unknown): value is LogoutCleanupTombstone {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.userId === null || typeof record.userId === 'string') &&
    (record.deviceSessionId === null || typeof record.deviceSessionId === 'string') &&
    (record.pushToken === null || typeof record.pushToken === 'string') &&
    typeof record.needsSessionRevoke === 'boolean' &&
    typeof record.needsPushUnregister === 'boolean' &&
    typeof record.failedAt === 'number' &&
    Number.isFinite(record.failedAt)
  );
}

export async function readLogoutCleanupTombstone(): Promise<LogoutCleanupTombstone | null> {
  try {
    const raw = await SecureStore.getItemAsync(LOGOUT_CLEANUP_TOMBSTONE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isLogoutCleanupTombstone(parsed)) {
      // A corrupt or invalid tombstone is discarded as absent: nothing is
      // actionable, the next failed logout writes a fresh one, and the record
      // can never become a different-user skip or trigger remote cleanup.
      return null;
    }
    return parsed;
  } catch {
    // A corrupt tombstone is discarded: nothing actionable, and the next
    // failed logout writes a fresh one.
    return null;
  }
}

export async function deleteLogoutCleanupTombstone(): Promise<void> {
  await SecureStore.deleteItemAsync(LOGOUT_CLEANUP_TOMBSTONE_KEY);
}

async function writeLogoutCleanupTombstone(tombstone: LogoutCleanupTombstone): Promise<void> {
  await SecureStore.setItemAsync(LOGOUT_CLEANUP_TOMBSTONE_KEY, JSON.stringify(tombstone));
}

/**
 * Runs remote logout cleanup while the token owner still serves auth headers
 * (called by sign-out BEFORE the epoch bump and BEFORE any credential
 * deletion). It NEVER throws: every step is internally caught, so a remote
 * or storage failure can never block local sign-out.
 *
 * - Revokes the current device session and unregisters the device push token
 *   concurrently, bounded at 15 s each by the tRPC client's `deadlineFetch`.
 * - Maps the settled results to exactly two flags and writes a tombstone only
 *   when at least one part is outstanding; a fully successful cleanup deletes
 *   any existing tombstone. A fulfilled part is never retried later.
 */
export async function runLogoutCleanup(): Promise<void> {
  try {
    const token = getActiveToken()?.token;
    const deviceSessionId = token ? deviceSessionIdFromToken(token) : null;
    const userId = readCachedUserId(queryClient);

    // Push token outcome: 'none' → nothing to unregister; 'lookup-failed' →
    // a server row may exist, so reconciliation re-reads the stable device
    // token and the tombstone stores pushToken: null.
    let pushToken: string | null = null;
    let pushLookupFailed = false;
    try {
      const outcome = await getDevicePushTokenOutcome();
      if (outcome.kind === 'token') {
        pushToken = outcome.token;
      } else if (outcome.kind === 'lookup-failed') {
        pushLookupFailed = true;
      }
    } catch {
      // Defensive: the outcome function never throws by contract.
      pushLookupFailed = true;
    }

    const results = await Promise.allSettled([
      trpcClient.user.revokeCurrentDeviceSession.mutate(),
      pushToken
        ? trpcClient.user.unregisterPushToken.mutate({ token: pushToken })
        : Promise.resolve(),
    ]);

    const revoke = results[0];
    const unregister = results[1];

    // Exact flag mapping: fulfilled (any outcome, including
    // `no_identifiable_session`) and the owner-side NOT_FOUND are done; any
    // other rejection keeps the part for reconciliation.
    let needsSessionRevoke = false;
    if (revoke.status === 'rejected' && !isNotFoundTrpcError(revoke.reason)) {
      needsSessionRevoke = true;
    }

    let needsPushUnregister = false;
    if (pushLookupFailed) {
      needsPushUnregister = true;
    } else if (pushToken !== null && unregister.status === 'rejected') {
      needsPushUnregister = true;
    }

    try {
      await (!needsSessionRevoke && !needsPushUnregister
        ? deleteLogoutCleanupTombstone()
        : writeLogoutCleanupTombstone({
            userId,
            deviceSessionId,
            pushToken,
            needsSessionRevoke,
            needsPushUnregister,
            failedAt: Date.now(),
          }));
    } catch (error) {
      // A tombstone write failure is reported but never blocks logout: the
      // orphaned session stays revocable server-side until its token expires.
      Sentry.captureException(error);
    }
  } catch (error) {
    // Never throw by contract: an unexpected failure anywhere in the gather
    // phase must not abort sign-out.
    Sentry.captureException(error);
  }
}
