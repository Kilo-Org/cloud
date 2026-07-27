import { getShareExtensionKey } from 'expo-share-intent';

import { redirectSystemPath as mapWebPath } from '@/lib/deep-link-handler';

// Composes both native-intent concerns: the share-extension check must return
// early before web-path mapping (a share URL is never a web route).
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  let shareKey: string | null = null;
  try {
    shareKey = getShareExtensionKey();
  } catch {
    shareKey = null;
  }
  if (shareKey && path.includes(`dataUrl=${shareKey}`)) {
    // Cold start: boot the app normally. Warm: stay exactly where the user is.
    return initial ? '/' : null;
  }
  return mapWebPath({ path, initial });
}
