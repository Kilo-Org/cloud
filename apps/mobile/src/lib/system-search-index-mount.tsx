import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
  applySystemSearchUpdate,
  indexedSystemSearchFingerprints,
} from '@/lib/native-system-search';
import { replaceNativeSessionCatalog } from '@/lib/app-actions/native-bridge';
import { clearSessionCatalogBestEffort } from '@/lib/app-actions/session-catalog';
import { isCatalogPublishAllowed, setAppLockStatus } from '@/lib/app-lock-state';
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
 * The mount's catalog dep. Only a known-unlocked app publishes: the lock
 * surface covers every other status, so a publish then would put titles back
 * behind it.
 */
function applySessionCatalog(sessions: readonly SessionCatalogEntry[]): Promise<boolean> {
  if (!isCatalogPublishAllowed()) {
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
  const syncRef = useRef<SystemSearchIndexSync | null>(null);
  const lastStatus = useRef<string | null>(null);

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
    syncRef.current = sync;
    const detach = sync.attach();
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void sync.syncNow();
      }
    });
    return () => {
      appStateSubscription.remove();
      detach();
      syncRef.current = null;
    };
  }, []);

  // The catalog follows the one gate that hides content. Entering the lock wipes
  // the titles, and so does a launch that is still reading the preference: the
  // lock surface already covers the app then, so the catalog the previous
  // process persisted must not stay readable for the length of that read. The
  // publish above refuses while any status other than `unlocked` stands.
  //
  // The unlock edge is also the retry for a publish that the gate refused: the
  // run that would have carried the titles happened while the lock stood, so
  // nothing else would re-publish them until an unrelated cache write.
  useEffect(() => {
    setAppLockStatus(status);
    const closed = status !== 'unlocked' && lastStatus.current !== status;
    lastStatus.current = status;
    if (closed) {
      clearSessionCatalogBestEffort();
    }
    if (status === 'unlocked') {
      void syncRef.current?.syncNow();
    }
  }, [status]);
  return null;
}
