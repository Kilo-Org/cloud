import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { type MobileRouter } from '@kilocode/trpc/mobile';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
} from '@/lib/auth/logout-reconciliation';
import { getDevicePushTokenOutcome, getPlatform } from '@/lib/notifications';
import { queryClient } from '@/lib/query-client';
import { trpcClient } from '@/lib/trpc';

const trpcOptions = createTRPCOptionsProxy<MobileRouter>({ client: trpcClient, queryClient });

/**
 * Reconciliation for push-token ownership: the `(app)` layout mounts the
 * trigger so that, once `user.getMe` has resolved and on each AppState return
 * to `active` while authenticated, the signed-in user owns the device's Expo
 * push token. A token rotation event defers to the same attempt.
 *
 * The attempt is single-flight with a per-user 60 s minimum spacing, epoch-fenced, and
 * never throws: a transient failure retries on the next foreground without
 * waiting for a remount, and a sign-out or sign-in mid-attempt drops the
 * result instead of registering for a stale user.
 */

const MIN_ATTEMPT_SPACING_MS = 60_000;

let attemptInFlight: Promise<PushRegistrationOutcome> | null = null;
let lastAttemptAtMs = 0;
let lastAttemptUserId: string | null = null;

export type PushRegistrationOutcome =
  | { kind: 'in-flight' }
  | { kind: 'spacing-skipped' }
  | { kind: 'no-permission' }
  | { kind: 'lookup-failed' }
  | { kind: 'already-registered' }
  | { kind: 'registered' }
  | { kind: 'register-failed' };

/** Test-only: clears the single-flight and spacing state between tests. */
export function resetPushRegistrationReconciliationForTests(): void {
  attemptInFlight = null;
  lastAttemptAtMs = 0;
  lastAttemptUserId = null;
}

/**
 * Single-flight, per-user minimum-60s-spaced reconciliation attempt for
 * `userId`. Returns the in-flight outcome when an attempt is already running,
 * and skips without any network call when the SAME user ran one within the
 * spacing window.
 */
export async function attemptPushRegistrationReconciliation(
  userId: string
): Promise<PushRegistrationOutcome> {
  // Order against logout cleanup for real: `unregisterPushToken` deletes the
  // current user's row for a token, so a same-user re-login could otherwise
  // delete the row this function just wrote. Trigger the logout attempt (which
  // starts a fresh run only when none is running), then await its settle so
  // registration cannot start until any in-flight unregister for this sign-in
  // has finished. Both are single-flight and 60 s spaced, so this is free when
  // nothing is pending.
  void attemptLogoutReconciliation(userId);
  await awaitLogoutReconciliationSettled();

  if (attemptInFlight) {
    return { kind: 'in-flight' };
  }
  const now = Date.now();
  if (now - lastAttemptAtMs < MIN_ATTEMPT_SPACING_MS && lastAttemptUserId === userId) {
    return { kind: 'spacing-skipped' };
  }
  lastAttemptAtMs = now;
  lastAttemptUserId = userId;
  attemptInFlight = runReconciliation();
  try {
    return await attemptInFlight;
  } finally {
    attemptInFlight = null;
  }
}

async function runReconciliation(): Promise<PushRegistrationOutcome> {
  const epoch = currentAuthEpoch();

  const deviceOutcome = await getDevicePushTokenOutcome();
  if (deviceOutcome.kind === 'none') {
    // The permission is not granted: reconciliation never asks for a
    // permission the user has not granted. The Notifications screen owns the
    // enable CTA.
    return { kind: 'no-permission' };
  }
  if (deviceOutcome.kind === 'lookup-failed') {
    return { kind: 'lookup-failed' };
  }
  const token = deviceOutcome.token;

  const tokens = await trpcClient.user.getMyPushTokens.query().catch(() => null);
  if (tokens === null) {
    // A failed lookup is a retryable network failure: the next foreground
    // retries after the spacing window.
    return { kind: 'register-failed' };
  }
  if (tokens.some(t => t.token === token)) {
    return { kind: 'already-registered' };
  }

  if (!isCurrentAuthEpoch(epoch)) {
    // A sign-out or sign-in during the lookup owns the session now: drop the
    // result so a stale reconciliation never registers for the wrong user.
    return { kind: 'register-failed' };
  }

  try {
    await trpcClient.user.registerPushToken.mutate({
      token,
      platform: getPlatform(),
      appVersion: Application.nativeApplicationVersion ?? undefined,
    });
  } catch {
    return { kind: 'register-failed' };
  }

  if (!isCurrentAuthEpoch(epoch)) {
    // A sign-out or sign-in during the mutate owns the session now: drop the
    // result so a stale reconciliation never invalidates for the wrong user.
    return { kind: 'register-failed' };
  }

  void queryClient.invalidateQueries({ queryKey: trpcOptions.user.getMyPushTokens.queryKey() });
  return { kind: 'registered' };
}

/**
 * Subscribes to Expo push-token rotation and defers each event to the shared
 * reconciliation. The listener body must not call `getExpoPushTokenAsync` or
 * `getDevicePushTokenAsync`: expo-notifications documents that calling a token
 * getter inside the listener retriggers the event and loops. The listener only
 * records that a rotation happened and defers the re-read to the shared path.
 *
 * The deferred reconciliation registers the Expo token (never the native
 * `DevicePushToken` the event carries) and does not unregister the previous
 * token: the device no longer holds it, and the server prunes it through
 * Expo's `DeviceNotRegistered` handling.
 */
export function subscribeToPushTokenRotation(userId: string): () => void {
  const subscription = Notifications.addPushTokenListener(() => {
    // Deferred out of the listener body — see the retrigger note above.
    setTimeout(() => {
      void attemptPushRegistrationReconciliation(userId);
    }, 0);
  });
  return () => {
    subscription.remove();
  };
}
