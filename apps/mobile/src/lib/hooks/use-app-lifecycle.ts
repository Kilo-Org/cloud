import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { createAppStateStore } from '@/lib/hooks/app-state-store';

const store = createAppStateStore(AppState);

export function useAppLifecycle() {
  return { isActive: useSyncExternalStore(store.subscribe, store.isActive) };
}
