import * as SecureStore from '@/lib/auth/secure-store';
import { readStoredValueRetryingNull } from '@/lib/auth/secure-store-read';

// The adoption hands an update token straight to the delivery, and it runs from
// the root layout's import. The route group that would otherwise install the
// delivery is evaluated later, so without this side-effect import the token
// would reach the no-op delivery and the card would stay orphaned.
import '@/lib/glanceable/delivery-registration';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import {
  ACTIVE_USER_ID_KEY,
  AUTH_TOKEN_KEY,
  ORGANIZATION_STORAGE_KEY,
  REFRESH_TOKEN_KEY,
} from '@/lib/storage-keys';

import { adoptNativeActivity, sweepStrayActivities } from './ios-sink';
import { restoreFollowedSessionCards, type SessionRestoreScope } from './session-follow';

/**
 * A stored value, `null` when the keychain holds nothing under the key, or
 * `undefined` when it could not answer at all. The two empty answers are not the
 * same: one is a state the app may act on, the other proves nothing.
 */
async function readKey(key: string): Promise<string | null | undefined> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // A keychain that cannot answer, like one before first unlock, only costs
    // this adoption; the publisher retries.
    return undefined;
  }
}

/**
 * A credential read: `undefined` when the keychain could not answer. A `null` is
 * retried on the credential cadence, because a credential key can answer `null`
 * before the device finishes unlocking.
 */
async function readCredential(key: string): Promise<string | null | undefined> {
  try {
    return await readStoredValueRetryingNull(key);
  } catch {
    return undefined;
  }
}

/**
 * Whether the keychain holds a credential, so the device is signed in.
 * `undefined` when the credential store could not be read. The identity hint is
 * written best effort, so a missing hint on its own is not a sign-out: a
 * signed-in device can lose the hint and still hold its tokens.
 */
async function hasStoredCredential(): Promise<boolean | undefined> {
  const authToken = await readCredential(AUTH_TOKEN_KEY);
  if (authToken === undefined) {
    return undefined;
  }
  if (authToken !== null) {
    return true;
  }
  const refreshToken = await readCredential(REFRESH_TOKEN_KEY);
  if (refreshToken === undefined) {
    return undefined;
  }
  return refreshToken !== null;
}

/**
 * The stored account and scope, as the launch and foreground restore reads it.
 * A keychain that answered with no account and no credential is a sign-out,
 * which ends every card. A device that keeps a credential but cannot name its
 * account, and one whose keychain could not answer at all, leave the cards as
 * they are.
 */
async function readStoredContext(): Promise<SessionRestoreScope> {
  const userId = await readKey(ACTIVE_USER_ID_KEY);
  if (userId === undefined) {
    return { kind: 'unreadable' };
  }
  if (userId === null) {
    // Only a device with no credential either is signed out: an absent hint
    // alone says nothing, and a signed-in scope that cannot be named is not one
    // this restore may end a card for.
    const signedIn = await hasStoredCredential();
    return signedIn === false ? { kind: 'signedOut' } : { kind: 'unreadable' };
  }
  const organizationId = await readKey(ORGANIZATION_STORAGE_KEY);
  if (organizationId === undefined) {
    // A read that failed proves nothing about the selection, so no card is out
    // of scope until the next read answers.
    return { kind: 'unreadable' };
  }
  return { kind: 'account', ctx: { userId, organizationId } };
}

/**
 * Rebuild the followed session cards from native truth and register again the
 * ones this account and organization followed (`session-follow.ts`). Runs at
 * launch and on every foreground.
 */
export async function restoreStoredSessionCards(): Promise<void> {
  await restoreFollowedSessionCards(await readStoredContext());
}

/**
 * Bind a Live Activity this process did not start.
 *
 * A push-to-start raises the card with no JavaScript running, and iOS then
 * grants the app background run time. The card's update token reaches the
 * server only once something reads the native instance, so until this runs the
 * server can neither update nor end that card — it can only raise another one,
 * and the Lock Screen collects frozen duplicates.
 *
 * Runs at import, ahead of any React tree or session query, in the foreground
 * process and in the headless push process alike. It sweeps native truth before
 * naming an owner, so a launch with nothing to adopt still retires the cards a
 * previous process left behind. The followed session cards are rebuilt here
 * too; the sweep never reads them.
 */
export async function adoptPushStartedActivity(): Promise<void> {
  await restorePersistedGlanceable();
  // Retire what this launch cannot own before anything else reads the surface.
  // It must run even when no snapshot or user is available: that is exactly the
  // state a stray from a killed or replaced process is left in, and the early
  // return below would otherwise leave it on the Lock Screen forever.
  sweepStrayActivities();
  const snapshot = getLastGlanceableSnapshot();
  const scope = await readStoredContext();
  await restoreFollowedSessionCards(scope);
  if (snapshot === null || scope.kind !== 'account') {
    return;
  }
  adoptNativeActivity(snapshot, scope.ctx);
}
