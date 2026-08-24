import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { type MobileRouter } from '@kilocode/trpc/mobile';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
} from '@/lib/auth/logout-reconciliation';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
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
// The locale the last attempt ran with. It only ever BYPASSES the spacing
// skip, so a stale value cannot suppress a registration. Whether the server
// row actually holds the current locale is decided by the row itself, not by
// this hint — see `runReconciliation`.
let lastAttemptLocale: string | null = null;

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
  lastAttemptLocale = null;
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

  const locale = getResolvedLanguage();
  const localeChanged = lastAttemptLocale !== locale;

  if (attemptInFlight) {
    if (lastAttemptUserId === userId) {
      return { kind: 'in-flight' };
    }
    // The in-flight attempt belongs to a different user: the app switched
    // accounts mid-attempt. Await it so the previous user's attempt settles,
    // then fall through to run this user's attempt. The spacing check below
    // keys on `lastAttemptUserId === userId`, so a different user is never
    // spacing-skipped.
    await attemptInFlight;
  }
  const now = Date.now();
  if (
    now - lastAttemptAtMs < MIN_ATTEMPT_SPACING_MS &&
    lastAttemptUserId === userId &&
    !localeChanged
  ) {
    return { kind: 'spacing-skipped' };
  }
  lastAttemptAtMs = now;
  lastAttemptUserId = userId;
  attemptInFlight = runReconciliation(locale);
  try {
    return await attemptInFlight;
  } finally {
    attemptInFlight = null;
  }
}

async function runReconciliation(locale: string): Promise<PushRegistrationOutcome> {
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
  // The server row decides. A cache keyed only by locale would answer
  // `already-registered` for the wrong account or the wrong token: the same
  // device can carry one token across a sign-out and sign-in, and the new
  // user's row may hold a different locale than the one last sent.
  // `locale` is null on a row written before the column existed; that is
  // English, so it only matches when English is the active language.
  const registered = tokens.find(t => t.token === token);
  if (registered && (registered.locale ?? 'en') === locale) {
    lastAttemptLocale = locale;
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
      locale,
    });
  } catch {
    return { kind: 'register-failed' };
  }

  if (!isCurrentAuthEpoch(epoch)) {
    // A sign-out or sign-in during the mutate owns the session now: drop the
    // result so a stale reconciliation never invalidates for the wrong user.
    return { kind: 'register-failed' };
  }

  // Set only on an outcome that proves the server row holds this locale. A
  // failed attempt leaves it stale on purpose, so the next attempt bypasses
  // the spacing skip and retries instead of waiting out the window.
  lastAttemptLocale = locale;
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
