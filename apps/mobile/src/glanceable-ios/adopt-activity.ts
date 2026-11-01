import * as SecureStore from '@/lib/auth/secure-store';
import { readStoredValueRetryingNull } from '@/lib/auth/secure-store-read';

// The adoption hands an update token straight to the delivery, and it runs from
// the root layout's import. The route group that would otherwise install the
// delivery is evaluated later, so without this side-effect import the token
// would reach the no-op delivery and the card would stay orphaned.
import '@/lib/glanceable/delivery-registration';
import {
  getGlanceableSnapshotForSignedInScope,
  restorePersistedGlanceable,
} from '@/lib/glanceable/persist';
import { readSignedInScope } from '@/lib/glanceable/scope';
import { AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY } from '@/lib/storage-keys';

import { adoptNativeActivity, sweepStrayActivities } from './ios-sink';
import { restoreFollowedSessionCards, type SessionRestoreScope } from './session-follow';

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
 * `undefined` when the credential store could not be read. The restore reports a
 * sign-out only for a keychain with no account hint and no credential; both keys
 * read together, so the retry budget is spent once.
 */
async function hasStoredCredential(): Promise<boolean | undefined> {
  const [authToken, refreshToken] = await Promise.all([
    readCredential(AUTH_TOKEN_KEY),
    readCredential(REFRESH_TOKEN_KEY),
  ]);
  if (authToken === undefined || refreshToken === undefined) {
    return undefined;
  }
  return authToken !== null || refreshToken !== null;
}

/**
 * The stored account and scope, as the launch and foreground restore reads it.
 * The account and organization come from the shared signed-in scope read
 * (`lib/glanceable/scope.ts`), so the restore and the snapshot fence cannot
 * disagree about which account is current.
 *
 * A keychain that answered with no account and no credential is a sign-out,
 * which ends every card. A device that keeps a credential but cannot name its
 * account, and one whose keychain could not answer at all, leave the cards as
 * they are.
 */
async function readStoredContext(): Promise<SessionRestoreScope> {
  const scope = await readSignedInScope(SecureStore);
  if (scope.status === 'unavailable') {
    // A read that did not complete proves nothing: no card is out of scope
    // until the next read answers.
    return { kind: 'unreadable' };
  }
  if (scope.status === 'known') {
    return {
      kind: 'account',
      ctx: { userId: scope.userId, organizationId: scope.organizationId },
    };
  }
  // Only a device with no credential either is signed out: an absent hint alone
  // says nothing, and a signed-in scope that cannot be named is not one this
  // restore may end a card for.
  const signedIn = await hasStoredCredential();
  return signedIn === false ? { kind: 'signedOut' } : { kind: 'unreadable' };
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
  const snapshot = getGlanceableSnapshotForSignedInScope();
  const scope = await readStoredContext();
  await restoreFollowedSessionCards(scope);
  if (snapshot === null || scope.kind !== 'account') {
    return;
  }
  adoptNativeActivity(snapshot, scope.ctx);
}
