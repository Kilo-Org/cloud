import { useSyncExternalStore } from 'react';

import { setLiveActivityEnabledValue } from '@/lib/glanceable/live-activity-switch';
import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { LIVE_ACTIVITY_KEY } from '@/lib/storage-keys';

/**
 * The in-app escape hatch for the Active Agents Live Activity.
 *
 * Separate from the per-app switch in Settings, which ActivityKit owns: this
 * one lets someone keep Live Activities for every other app and stop only
 * Kilo's. Both must allow it for the activity to start — see `ios-sink`.
 *
 * Default-on: only the exact stored string 'false' turns it off, so a missing
 * or unreadable value keeps the behavior the app ships with.
 */
function parseLiveActivityEnabled(raw: string | null): boolean {
  return raw !== 'false';
}

const store = createSecureStorePreference<boolean>({
  key: LIVE_ACTIVITY_KEY,
  defaultValue: true,
  parse: parseLiveActivityEnabled,
  serialize: value => (value ? 'true' : 'false'),
});

// Mirror the persisted value into the React-Native-free holder the sink reads.
// Subscribing also starts the disk read, so the mirror is correct from the
// first emit rather than from the first render of the settings screen.
store.subscribe(() => {
  setLiveActivityEnabledValue(store.get());
});
setLiveActivityEnabledValue(store.get());

export function clearLiveActivityPreference() {
  store.clear();
}

function setLiveActivityEnabled(value: boolean) {
  store.set(value);
}

export function useLiveActivityPreference() {
  const liveActivityEnabled = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { liveActivityEnabled, hasLoaded, setLiveActivityEnabled };
}
