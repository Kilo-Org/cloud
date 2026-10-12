import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptLogoutReconciliation,
  awaitLogoutReconciliationSettled,
  hasPendingActivityUnregister,
} from '@/lib/auth/logout-reconciliation';
import { trpcClient } from '@/lib/trpc';

import { enqueueTokenMutation } from './token-mutation-queue';
import { deleteActivityTokens, readUnregisterAuthToken } from './unregister-session';

/**
 * The push-token rows of the followed sessions on Android
 * (`android_session_ongoing`). One device's Expo push token carries one row per
 * followed session, plus its `android_ongoing` aggregate row, so every call
 * names the session: deleting by the token alone would take the device's other
 * rows with it.
 *
 * The register/delete lifecycle is the iOS session card's: the same FIFO and
 * logout fences, and a registration stays pending until the server accepts it.
 * `retryAndroidSessionTokens` runs it again at the next foreground and the next
 * publish, so a transient network failure cannot leave a followed session
 * invisible to the server. A scope teardown deletes every recorded token before
 * the device session is revoked, as it does for the aggregate card.
 */

export type AndroidSessionScope = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
};

/** Every session token until its delete succeeds. A scope teardown deletes these too. */
export const androidSessionActivityTokens = new Set<string>();

/** The token the server accepted for each followed session. */
const tokensBySession = new Map<string, string>();

/** One pending follow, with the auth epoch it was made in. */
type PendingRegistration = AndroidSessionScope & { authEpoch: number };

/** Every follow whose registration has not landed yet, by session id. */
const pending = new Map<string, PendingRegistration>();

/** Sessions with a registration attempt running now, so a retry cannot double it. */
const inFlight = new Set<string>();

let registeredScope: { userId: string; organizationId: string | null } | null = null;

/**
 * True while the follow still belongs to the signed-in scope: the same account
 * and organization, and no sign-in or sign-out since it was made.
 */
function isCurrent(scope: PendingRegistration): boolean {
  return (
    registeredScope !== null &&
    registeredScope.userId === scope.userId &&
    registeredScope.organizationId === scope.organizationId &&
    isCurrentAuthEpoch(scope.authEpoch)
  );
}

/** A suite's device-token reader: a lazy `require` is not reachable by `vi.mock`. */
let deviceTokenReaderForTests: (() => Promise<string | null>) | null = null;

export function _setDevicePushTokenReaderForTests(
  reader: (() => Promise<string | null>) | null
): void {
  deviceTokenReaderForTests = reader;
}

/** The device's Expo push token, loaded lazily so pure tests never load the native module. */
async function getDevicePushToken(): Promise<string | null> {
  try {
    if (deviceTokenReaderForTests !== null) {
      return await deviceTokenReaderForTests();
    }
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const { getDevicePushToken: read } = require('@/lib/notifications') as {
      getDevicePushToken: () => Promise<string | null>;
    };
    return await read();
  } catch {
    return null;
  }
}

/** One registration attempt. Resolves true when the server holds the row. */
async function attemptRegistration(scope: PendingRegistration): Promise<boolean> {
  const token = await getDevicePushToken();
  if (token === null || token.length === 0 || !isCurrent(scope)) {
    return false;
  }
  if (tokensBySession.get(scope.sessionId) === token) {
    return true;
  }
  void attemptLogoutReconciliation(scope.userId);
  await awaitLogoutReconciliationSettled();
  if (!isCurrent(scope) || (await hasPendingActivityUnregister(scope.userId))) {
    return false;
  }
  await enqueueTokenMutation(async () => {
    // An unfollow queued its delete after this attempt started: registering now
    // would bring the row back.
    if (
      !isCurrent(scope) ||
      pending.get(scope.sessionId) !== scope ||
      tokensBySession.get(scope.sessionId) === token
    ) {
      return;
    }
    // An upsert whose answer never arrives can still have landed: keep the
    // token for the scope teardown before the call goes out.
    androidSessionActivityTokens.add(token);
    await trpcClient.user.registerActivityToken.mutate({
      token,
      kind: 'android_session_ongoing',
      platform: 'android',
      organizationId: scope.organizationId,
      sessionId: scope.sessionId,
    });
    tokensBySession.set(scope.sessionId, token);
  });
  return tokensBySession.get(scope.sessionId) === token;
}

/** Run the pending registration of one session once, unless one already runs. */
async function runRegistration(sessionId: string): Promise<void> {
  const scope = pending.get(sessionId);
  if (scope === undefined || inFlight.has(sessionId)) {
    return;
  }
  inFlight.add(sessionId);
  try {
    // A follow that left the scope has nothing to register; drop it.
    if (!isCurrent(scope)) {
      pending.delete(sessionId);
      return;
    }
    // Only the registration this attempt ran for is settled: a newer follow of
    // the same session replaced the entry and stays pending.
    if ((await attemptRegistration(scope)) && pending.get(sessionId) === scope) {
      pending.delete(sessionId);
    }
  } catch {
    // The follow stays pending; the next foreground or publish retries it.
  } finally {
    inFlight.delete(sessionId);
  }
}

/**
 * Register this device's Expo push token for one followed session. The follow
 * stays pending until the server accepts it.
 */
export async function registerAndroidSessionToken(scope: AndroidSessionScope): Promise<void> {
  pending.set(scope.sessionId, { ...scope, authEpoch: currentAuthEpoch() });
  await runRegistration(scope.sessionId);
}

/**
 * Retry every follow whose registration has not landed. The app calls this at
 * the next foreground and the next publish.
 */
export async function retryAndroidSessionTokens(): Promise<void> {
  const sessions = [...pending.keys()];
  await Promise.all(
    sessions.map(async sessionId => {
      await runRegistration(sessionId);
    })
  );
}

/** True while a follow of this session waits for its registration. */
export function isAndroidSessionTokenPending(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** Delete one session's row for this device; a failed delete is retried by the scope teardown. */
async function deleteSessionRow(sessionId: string, token: string): Promise<void> {
  await enqueueTokenMutation(async () => {
    const authToken = await readUnregisterAuthToken();
    if (authToken === null) {
      return;
    }
    await deleteActivityTokens([token], authToken, [androidSessionActivityTokens], sessionId);
  });
}

/**
 * Forget one followed session: drop its pending registration and delete its row.
 * The device's other followed sessions keep their rows. When this process never
 * learned the token (a fresh process, or a registration that has not answered),
 * the device token is read again, so a dismissed follow cannot leave its row.
 */
export async function releaseAndroidSessionToken(sessionId: string): Promise<void> {
  pending.delete(sessionId);
  const known = tokensBySession.get(sessionId);
  tokensBySession.delete(sessionId);
  const token = known ?? (await getDevicePushToken());
  if (token !== null && token.length > 0) {
    await deleteSessionRow(sessionId, token);
  }
}

/** Enter a session's scope: the logout fence and the epoch compare against this. */
export function setAndroidSessionScope(scope: {
  userId: string;
  organizationId: string | null;
}): void {
  registeredScope = scope;
}

/** Test-only: drop the recorded scope, tokens, and pending registrations. */
export function _resetAndroidSessionTokensForTests(): void {
  registeredScope = null;
  tokensBySession.clear();
  pending.clear();
  inFlight.clear();
  androidSessionActivityTokens.clear();
}
