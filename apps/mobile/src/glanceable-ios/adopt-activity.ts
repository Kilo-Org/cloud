import * as SecureStore from '@/lib/auth/secure-store';

// The adoption hands an update token straight to the delivery, and it runs from
// the root layout's import. The route group that would otherwise install the
// delivery is evaluated later, so without this side-effect import the token
// would reach the no-op delivery and the card would stay orphaned.
import '@/lib/glanceable/delivery-registration';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { decodeSelection } from '@/lib/organization-selection';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { adoptNativeActivity, sweepStrayActivities } from './ios-sink';
import { restoreFollowedSessionCards, type SessionFollowContext } from './session-follow';

async function readKey(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // An unavailable keychain only costs this adoption; the publisher retries.
    return null;
  }
}

/** The stored account and scope, or null when no account can be read now. */
async function readStoredContext(): Promise<SessionFollowContext | null> {
  const userId = await readKey(ACTIVE_USER_ID_KEY);
  if (userId === null) {
    return null;
  }
  return { userId, organizationId: decodeSelection(await readKey(ORGANIZATION_STORAGE_KEY)) };
}

/**
 * Rebuild the followed session cards from native truth and register their
 * tokens again (`session-follow.ts`). Runs at launch and on every foreground.
 */
export async function restoreStoredSessionCards(): Promise<void> {
  restoreFollowedSessionCards(await readStoredContext());
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
  const ctx = await readStoredContext();
  restoreFollowedSessionCards(ctx);
  if (snapshot === null || ctx === null) {
    return;
  }
  adoptNativeActivity(snapshot, ctx);
}
