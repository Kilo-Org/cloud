import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import * as z from 'zod';

import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { readCachedUserId } from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { LOGOUT_CLEANUP_TOMBSTONE_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

/**
 * Safe-retry tombstone for a failed push-token unregister (DEC-01). Exactly
 * ONE pending cleanup is supported: a later failed logout overwrites an
 * earlier tombstone.
 *
 * A failed device-session revoke is NOT retried. The device already destroyed
 * the refresh token locally, and the access token expires within 1 h, so the
 * orphaned row is dead — it only lingers in the session list until then. A
 * push token is different: an unregistered device keeps receiving
 * notifications for the signed-out account until the row is gone, which the
 * user sees.
 *
 * The tombstone is written directly with `SecureStore.setItemAsync`,
 * deliberately NOT epoch-fenced: it must survive sign-out by design, and
 * sign-out must never delete it.
 */
/**
 * Every field is validated so a malformed record is discarded instead of being
 * interpreted as a different-user skip or driving unsafe remote cleanup.
 * `z.number()` rejects NaN and Infinity, so `failedAt` is always finite.
 */
const logoutCleanupTombstoneSchema = z.object({
  /** getMe cache identity at logout, or null when the query had not resolved. */
  userId: z.string().nullable(),
  /** Device push token at logout; null when lookup failed or permission missing. */
  pushToken: z.string().nullable(),
  needsPushUnregister: z.boolean(),
  /** Epoch ms of the failed logout; reconciliation discards past 30 days. */
  failedAt: z.number(),
});

export type LogoutCleanupTombstone = z.infer<typeof logoutCleanupTombstoneSchema>;

export async function readLogoutCleanupTombstone(): Promise<LogoutCleanupTombstone | null> {
  try {
    const raw = await SecureStore.getItemAsync(LOGOUT_CLEANUP_TOMBSTONE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = logoutCleanupTombstoneSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // A corrupt or invalid tombstone is discarded as absent: nothing is
      // actionable, the next failed logout writes a fresh one, and the record
      // can never become a different-user skip or trigger remote cleanup.
      return null;
    }
    return parsed.data;
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
 * - A failed revoke is not recorded: see the tombstone type for why. A failed
 *   push unregister writes a tombstone; a successful one deletes any existing
 *   tombstone, and is never retried later.
 */
export async function runLogoutCleanup(): Promise<void> {
  try {
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

    const unregister = results[1];

    let needsPushUnregister = false;
    if (pushLookupFailed) {
      needsPushUnregister = true;
    } else if (pushToken !== null && unregister.status === 'rejected') {
      needsPushUnregister = true;
    }

    try {
      await (needsPushUnregister
        ? writeLogoutCleanupTombstone({
            userId,
            pushToken,
            needsPushUnregister,
            failedAt: Date.now(),
          })
        : deleteLogoutCleanupTombstone());
    } catch (error) {
      // A tombstone write failure is reported but never blocks logout: the
      // push row stays removable on the next successful unregister.
      Sentry.captureException(error);
    }
  } catch (error) {
    // Never throw by contract: an unexpected failure anywhere in the gather
    // phase must not abort sign-out.
    Sentry.captureException(error);
  }
}
