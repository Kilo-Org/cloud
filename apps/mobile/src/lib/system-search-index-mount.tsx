import { useEffect } from 'react';
import { AppState } from 'react-native';
import {
  applySystemSearchUpdate,
  indexedSystemSearchFingerprints,
} from '@/lib/native-system-search';
import { replaceNativeSessionCatalog } from '@/lib/app-actions/native-bridge';
import { clearSessionCatalogBestEffort } from '@/lib/app-actions/session-catalog';
import { isAppLocked, setAppLocked } from '@/lib/app-lock-state';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { queryClient } from '@/lib/query-client';
import {
  collectSystemSearchDocuments,
  type SessionCatalogEntry,
  type SystemSearchCollection,
} from '@/lib/system-search-collect';
import {
  isSystemSearchSyncEnabled,
  SystemSearchIndexSync,
  type SystemSearchIndexUpdate,
} from '@/lib/system-search-sync';
import { reportSystemSearchFailure } from '@/lib/system-search-telemetry';

/** The mount's collect dep: the cache collector bound to the app's client. */
async function collectIndexUpdates(): Promise<SystemSearchCollection> {
  const collection = await collectSystemSearchDocuments(queryClient);
  return collection;
}

/** The mount's apply dep: the plan's `remove` is the bridge's `removeIds`. */
async function applyIndexUpdate(update: SystemSearchIndexUpdate): Promise<void> {
  await applySystemSearchUpdate({ add: update.add, removeIds: update.remove });
}

/**
 * The mount's catalog dep. A locked app keeps no titles outside the lock: the
 * lock already wiped them, so a publish that runs while it is up must not put
 * them back.
 */
function applySessionCatalog(sessions: readonly SessionCatalogEntry[]): Promise<boolean> {
  if (isAppLocked()) {
    return Promise.resolve(false);
  }
  return replaceNativeSessionCatalog(sessions);
}

/**
 * Keeps the phone's own search index in step with the data the app already
 * holds. It renders nothing and fetches nothing: the sync reads the query
 * cache, and the cache events below are what wake it.
 *
 * It mounts inside the signed-in `(app)` group, so unmounting at sign-out
 * drops the cache subscription; `isEnabled` also folds in the sign-out flag so
 * an in-flight teardown never re-indexes. Each return to `active` re-runs the
 * sync, which is the retry for a native write that failed.
 *
 * The same run publishes the App Intents session catalog. It is not a second
 * subscription: the catalog is the session rows of the same collection, it
 * needs the same account fence, and a second owner would have to repeat the
 * coalescing and the fencing to reach the same guarantee.
 */
export function SystemSearchIndexMount(): null {
  const { status } = useAppUnlock();
  const locked = status === 'locked';

  // The catalog follows the one gate that hides content. A locked app must not
  // keep offering session titles to Siri, so entering the lock wipes them, and
  // the publish below refuses while the flag stands. Publishing the flag first
  // is what makes the wipe and the gate agree.
  useEffect(() => {
    setAppLocked(locked);
    if (locked) {
      clearSessionCatalogBestEffort();
    }
  }, [locked]);

  useEffect(() => {
    const sync = new SystemSearchIndexSync({
      queryClient,
      collect: collectIndexUpdates,
      fingerprints: indexedSystemSearchFingerprints,
      apply: applyIndexUpdate,
      applySessions: applySessionCatalog,
      report: error => {
        reportSystemSearchFailure('sync', error);
      },
      isEnabled: isSystemSearchSyncEnabled,
    });
    const detach = sync.attach();
    void sync.syncNow();
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void sync.syncNow();
      }
    });
    return () => {
      appStateSubscription.remove();
      detach();
    };
  }, []);
  return null;
}
