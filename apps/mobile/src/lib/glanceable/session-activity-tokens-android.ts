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
 * The register/delete lifecycle is the aggregate card's — the same FIFO and the
 * same logout fences — so a failed delete is kept for a later cleanup instead of
 * lost.
 */

export type AndroidSessionScope = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
};

/** Every session token until its delete succeeds. A scope teardown deletes these too. */
export const androidSessionActivityTokens = new Set<string>();

/** The token last registered for each followed session. */
const tokensBySession = new Map<string, string>();

let registeredScope: { userId: string; organizationId: string | null } | null = null;

function isCurrent(scope: AndroidSessionScope): boolean {
  return (
    registeredScope !== null &&
    registeredScope.userId === scope.userId &&
    registeredScope.organizationId === scope.organizationId &&
    isCurrentAuthEpoch(currentAuthEpoch())
  );
}

/** The device's Expo push token, loaded lazily so pure tests never load the native module. */
async function getDevicePushToken(): Promise<string | null> {
  try {
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const { getDevicePushToken: read } = require('@/lib/notifications') as {
      getDevicePushToken: () => Promise<string | null>;
    };
    return await read();
  } catch {
    return null;
  }
}

/**
 * Register this device's Expo push token for one followed session. A second
 * call for a session retries a registration that has not landed.
 */
export function registerAndroidSessionToken(scope: AndroidSessionScope): void {
  if (!isCurrent(scope)) {
    return;
  }
  void (async () => {
    try {
      const token = await getDevicePushToken();
      if (token === null || token.length === 0 || !isCurrent(scope)) {
        return;
      }
      if (tokensBySession.get(scope.sessionId) === token) {
        return;
      }
      void attemptLogoutReconciliation(scope.userId);
      await awaitLogoutReconciliationSettled();
      if (!isCurrent(scope) || (await hasPendingActivityUnregister(scope.userId))) {
        return;
      }
      await enqueueTokenMutation(async () => {
        if (!isCurrent(scope) || tokensBySession.get(scope.sessionId) === token) {
          return;
        }
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
    } catch {
      // The notification keeps its local content; the next foreground retries.
    }
  })();
}

/**
 * Forget one followed session. The row is deleted with the token this device
 * registered for it, so the device's other followed sessions keep their rows; a
 * token the app never read is a no-op.
 */
export function releaseAndroidSessionToken(sessionId: string): void {
  const token = tokensBySession.get(sessionId);
  tokensBySession.delete(sessionId);
  if (token === undefined) {
    return;
  }
  void enqueueTokenMutation(async () => {
    const authToken = await readUnregisterAuthToken();
    if (authToken === null) {
      return;
    }
    await deleteActivityTokens([token], authToken, [androidSessionActivityTokens], sessionId);
  });
}

/** Enter a session's scope: the logout fence and the epoch compare against this. */
export function setAndroidSessionScope(scope: {
  userId: string;
  organizationId: string | null;
}): void {
  registeredScope = scope;
}

/**
 * Drop one session's row for this device without a local follow: the app no
 * longer follows it (a dismissal, or a follow cleared elsewhere), so a later
 * push must not address a stale token. Reads the device token and deletes the
 * row; a session with no row is a no-op.
 */
export function dropAndroidSessionRow(sessionId: string): void {
  tokensBySession.delete(sessionId);
  void (async () => {
    const token = await getDevicePushToken();
    if (token === null || token.length === 0) {
      return;
    }
    void enqueueTokenMutation(async () => {
      const authToken = await readUnregisterAuthToken();
      if (authToken === null) {
        return;
      }
      await deleteActivityTokens([token], authToken, [androidSessionActivityTokens], sessionId);
    });
  })();
}

/** Test-only: drop the recorded scope and tokens. */
export function _resetAndroidSessionTokensForTests(): void {
  registeredScope = null;
  tokensBySession.clear();
  androidSessionActivityTokens.clear();
}
