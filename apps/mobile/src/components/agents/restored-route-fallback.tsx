import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { RESTORED_ROUTE_FALLBACK_HREF } from '@/lib/last-route-repair';

/**
 * Leave the dead end an automatic restore opened. The relaunch repair restored
 * the stored route, and the session it names no longer resolves, so the app
 * goes back to the screen it starts on instead of holding a not-found screen
 * nobody asked for. The view underneath keeps its recovery controls, so a
 * navigation that cannot run is not another dead end.
 */
export function RestoredRouteFallback(): null {
  const router = useRouter();
  useEffect(() => {
    router.dismissTo(RESTORED_ROUTE_FALLBACK_HREF);
  }, [router]);
  return null;
}
