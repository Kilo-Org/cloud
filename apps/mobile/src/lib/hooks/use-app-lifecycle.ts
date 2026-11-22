import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { setUploadForegroundSource } from '@/lib/agent-attachments/upload-task';
import { createAppStateStore } from '@/lib/hooks/app-state-store';

const store = createAppStateStore(AppState);

// The attachment upload's inactivity window only counts foreground time: an iOS
// transfer runs in a background URLSession, so a window that spanned a
// suspension would fire on return and cancel an upload that never stalled.
// `upload-task` stays free of `react-native` imports so its contract is
// testable, so the app hands it the one real source here, next to the single
// foreground store this module already owns.
setUploadForegroundSource(AppState);

export function useAppLifecycle() {
  return { isActive: useSyncExternalStore(store.subscribe, store.isActive) };
}
