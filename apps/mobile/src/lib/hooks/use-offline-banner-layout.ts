import { useSyncExternalStore } from 'react';

import { getOfflineBannerHeight, subscribeOfflineBannerHeight } from '@/lib/offline-banner-layout';

/**
 * Height (px) currently occupied by the app-wide OfflineBanner at the top of
 * the window; 0 while it is hidden. Synchronous store consumers (e.g.
 * `ScreenHeader`) add it to their top padding so the absolute overlay never
 * paints over their content.
 */
export function useOfflineBannerHeight(): number {
  return useSyncExternalStore(subscribeOfflineBannerHeight, getOfflineBannerHeight);
}
