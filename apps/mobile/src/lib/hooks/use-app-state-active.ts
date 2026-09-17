import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { createAppStateStore } from '@/lib/hooks/app-state-store';

/**
 * The kilo-chat surfaces gate presence on whether the app is in the
 * foreground. One module-level store means every mounted consumer shares one
 * React Native `AppState` listener and one snapshot.
 *
 * The seed is the live `AppState.currentState`, not `true`: the hooks this
 * replaces initialised from `AppState.currentState === 'active'`, which is
 * `false` on a cold start when `currentState` is still `null`. This store is
 * deliberately separate from `use-app-lifecycle`'s, whose seed is `true` by
 * contract.
 */
const store = createAppStateStore(AppState, () => AppState.currentState === 'active');

export function useAppStateActive(): boolean {
  return useSyncExternalStore(store.subscribe, store.isActive);
}
