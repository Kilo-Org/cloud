'use client';

import { useSyncExternalStore } from 'react';
import type { HarnessStore } from './resume';

export function useHarnessState(store: HarnessStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
