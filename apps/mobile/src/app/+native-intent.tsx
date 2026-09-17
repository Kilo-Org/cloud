import { getShareExtensionKey } from 'expo-share-intent';

import { handleAppActionPath } from '@/lib/app-actions/action-url-handler';
import { redirectSystemPath as mapWebPath } from '@/lib/deep-link-handler';

// Composes the native-intent concerns in order: the share-extension check
// returns early before web-path mapping (a share URL is never a web route), then
// an app-action URL is handled by its own contract, and only what neither owns
// reaches the universal-link mapper. Both handled branches return falsy
// (`deep-link-handler.ts`); a truthy return re-dispatches the linking resolver.
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
  if (handleAppActionPath({ path, initial })) {
    return null;
  }
  return mapWebPath({ path, initial });
}
