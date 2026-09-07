import * as SecureStore from 'expo-secure-store';

// The adoption hands an update token straight to the delivery, and it runs from
// the root layout's import. The route group that would otherwise install the
// delivery is evaluated later, so without this side-effect import the token
// would reach the no-op delivery and the card would stay orphaned.
import '@/lib/glanceable/delivery-registration';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { adoptNativeActivity } from './ios-sink';

async function readKey(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // An unavailable keychain only costs this adoption; the publisher retries.
    return null;
  }
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
 * process and in the headless push process alike. The native read inside also
 * retires every instance except the adopted one.
 */
export async function adoptPushStartedActivity(): Promise<void> {
  await restorePersistedGlanceable();
  const snapshot = getLastGlanceableSnapshot();
  const userId = await readKey(ACTIVE_USER_ID_KEY);
  if (snapshot === null || userId === null) {
    return;
  }
  adoptNativeActivity(snapshot, {
    userId,
    organizationId: await readKey(ORGANIZATION_STORAGE_KEY),
  });
}
