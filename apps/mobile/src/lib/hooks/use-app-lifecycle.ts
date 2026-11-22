import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { setUploadForegroundSource } from '@/lib/agent-attachments/upload-foreground';
import { createAppStateStore } from '@/lib/hooks/app-state-store';

const store = createAppStateStore(AppState);

// The attachment upload's inactivity window only counts foreground time: an iOS
// transfer runs in a background URLSession, so a window that spanned a
// suspension would fire on return and cancel an upload that never stalled.
// The registration goes through the dependency-free registry, not through
// `upload-task`, so this module keeps the imports it always had and the upload
// module stays loadable in the node test project.
setUploadForegroundSource(AppState);

export function useAppLifecycle() {
  return { isActive: useSyncExternalStore(store.subscribe, store.isActive) };
}
