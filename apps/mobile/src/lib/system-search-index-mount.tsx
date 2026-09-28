import { useEffect } from 'react';
import { AppState } from 'react-native';
import {
  applySystemSearchUpdate,
  indexedSystemSearchFingerprints,
} from '@/lib/native-system-search';
import { queryClient } from '@/lib/query-client';
import {
  collectSystemSearchDocuments,
  type SystemSearchCollection,
} from '@/lib/system-search-collect';
import {
  isSystemSearchSyncEnabled,
  SystemSearchIndexSync,
  type SystemSearchIndexUpdate,
} from '@/lib/system-search-sync';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * One report per failed sync, tagged so the subsystem is filterable. The
 * rejected error is reported as-is; the module never logs a document id or a
 * title.
 */
function reportSystemSearchSyncFailure(error: unknown): void {
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'system-search', 'error.operation': 'sync' },
  });
}

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
 * Keeps the phone's own search index in step with the data the app already
 * holds. It renders nothing and fetches nothing: the sync reads the query
 * cache, and the cache events below are what wake it.
 *
 * It mounts inside the signed-in `(app)` group, so unmounting at sign-out
 * drops the cache subscription; `isEnabled` also folds in the sign-out flag so
 * an in-flight teardown never re-indexes. Each return to `active` re-runs the
 * sync, which is the retry for a native write that failed.
 */
export function SystemSearchIndexMount(): null {
  useEffect(() => {
    const sync = new SystemSearchIndexSync({
      queryClient,
      collect: collectIndexUpdates,
      fingerprints: indexedSystemSearchFingerprints,
      apply: applyIndexUpdate,
      report: reportSystemSearchSyncFailure,
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
