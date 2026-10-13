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
 *
 * The last call wins. Every register and release records the session's desired
 * state synchronously, when it is made (a follow in `pending`, and a new
 * `generations` number for both), and every server mutation runs in the FIFO
 * and acts on the desired state as it is when the mutation runs, not as it was
 * when it was queued: an upsert runs only while its follow is still the pending
 * one, and a delete only while its release is still the latest call. So an
 * upsert and a delete for one session commute: whichever call was made later
 * decides the row, however their awaits interleave.
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

/**
 * The number of the latest register or release call of each session. Numbers
 * come from one process-wide clock and never repeat, so an entry can be pruned
 * and recreated without an old queued delete ever matching a newer call.
 */
const generations = new Map<string, number>();
let generationClock = 0;

/** Release calls of each session whose delete has not settled yet. */
const releasesInFlight = new Map<string, number>();

function nextGeneration(sessionId: string): number {
  generationClock += 1;
  generations.set(sessionId, generationClock);
  return generationClock;
}

/**
 * Forget a session's generation once no call can still read it: nothing is
 * pending, no registration attempt runs, and no release's delete waits. Only a
 * queued delete compares generations (an upsert checks its own pending entry),
 * so the map then holds nothing any operation needs, and it stays bounded by
 * the sessions with work in progress.
 */
function pruneGeneration(sessionId: string): void {
  if (
    !pending.has(sessionId) &&
    !inFlight.has(sessionId) &&
    (releasesInFlight.get(sessionId) ?? 0) === 0
  ) {
    generations.delete(sessionId);
  }
}

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
    // A release during the call already queued the row's delete behind this
    // upsert; claiming the row now would make a later re-follow skip its own
    // upsert and leave the session with no row.
    if (pending.get(scope.sessionId) === scope) {
      tokensBySession.set(scope.sessionId, token);
    }
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
    // Every exit, the early ones included; a follow made meanwhile keeps it.
    pruneGeneration(sessionId);
  }
  // A re-follow made while this attempt ran replaced the entry, and the guard
  // above skipped it: run it now instead of waiting for the next retry.
  const next = pending.get(sessionId);
  if (next !== undefined && next !== scope) {
    await runRegistration(sessionId);
  }
}

/**
 * Register this device's Expo push token for one followed session. The follow
 * stays pending until the server accepts it.
 */
export async function registerAndroidSessionToken(scope: AndroidSessionScope): Promise<void> {
  nextGeneration(scope.sessionId);
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

/** Test-only: how many sessions still hold a generation entry. */
export function _androidSessionGenerationCountForTests(): number {
  return generations.size;
}

/** True while a follow of this session waits for its registration. */
export function isAndroidSessionTokenPending(sessionId: string): boolean {
  return pending.has(sessionId);
}

/**
 * Delete one session's row for this device, unless a later call superseded the
 * release that asked for it: a re-follow made meanwhile holds the row, and its
 * upsert may already have run ahead of this delete in the FIFO. A failed delete
 * is retried by the scope teardown.
 */
async function deleteSessionRow(
  sessionId: string,
  token: string,
  generation: number
): Promise<void> {
  await enqueueTokenMutation(async () => {
    if (generations.get(sessionId) !== generation) {
      return;
    }
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
  const generation = nextGeneration(sessionId);
  releasesInFlight.set(sessionId, (releasesInFlight.get(sessionId) ?? 0) + 1);
  pending.delete(sessionId);
  const known = tokensBySession.get(sessionId);
  tokensBySession.delete(sessionId);
  try {
    const token = known ?? (await getDevicePushToken());
    if (token !== null && token.length > 0) {
      await deleteSessionRow(sessionId, token, generation);
    }
  } finally {
    const remaining = (releasesInFlight.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      releasesInFlight.set(sessionId, remaining);
    } else {
      releasesInFlight.delete(sessionId);
    }
    pruneGeneration(sessionId);
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
  generations.clear();
  releasesInFlight.clear();
  androidSessionActivityTokens.clear();
}
