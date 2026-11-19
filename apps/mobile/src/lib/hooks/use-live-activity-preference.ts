import { useSyncExternalStore } from 'react';

import { parseLiveActivityEnabled } from '@/lib/glanceable/live-activity-preference-store';
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
 * The parse rule and the headless read live in
 * `live-activity-preference-store`, so the settings path and the headless read
 * share one rule and one retry budget.
 */
const store = createSecureStorePreference<boolean>({
  key: LIVE_ACTIVITY_KEY,
  defaultValue: true,
  parse: parseLiveActivityEnabled,
  serialize: value => (value ? 'true' : 'false'),
});

// Mirror the persisted value into the React-Native-free holder the sink reads.
// Subscribing also starts the disk read, so the mirror is correct from the
// first emit rather than from the first render of the settings screen.
//
// `store.get()` is the default on until the read lands, and the holder must not
// take that default for consent: the iOS push-to-start token stays refused
// until a stored answer arrives. `setLiveActivityEnabledValue` is therefore the
// only signal, and it runs only once the read has an answer. A load that reads
// the default on marks the preference known without a value change, so no
// running activity ends.
//
// It gates on the store knowing what is stored, not on `getHasLoaded`, which
// also settles for a rejected read: mirroring that would take the default on as
// consent exactly when the keychain is unreadable. A rejected read leaves the
// holder unknown until a write lands or the app next starts — the retrying read
// already spent its budget, so nothing re-reads sooner — and a refused
// push-to-start token waits for one of those answers.
const mirrorAnsweredValue = () => {
  const loaded = store.getAnsweredValue();
  if (!loaded.answered) {
    return;
  }
  setLiveActivityEnabledValue(loaded.value);
};
store.subscribe(mirrorAnsweredValue);
mirrorAnsweredValue();

export function clearLiveActivityPreference() {
  store.clear();
}

export function setLiveActivityEnabled(value: boolean) {
  store.set(value);
}

/** The stored Live Activity value for callers with no React tree (the settings registry). */
export function getLiveActivityEnabled(): boolean {
  return store.getRequested();
}

export function useLiveActivityPreference() {
  const liveActivityEnabled = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { liveActivityEnabled, hasLoaded, setLiveActivityEnabled };
}
