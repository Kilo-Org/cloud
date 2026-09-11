/**
 * The height (px) the app-wide OfflineBanner has measured for itself.
 *
 * The banner is an absolute overlay at the safe-area top, so any header that
 * starts there would be drawn under it (SPOT-DEFECT e6: the offline banner
 * clipped the "New session" title). Headers reserve the banner's space by
 * reading this store through `useOfflineBannerHeight`; the banner reports its
 * rendered height through `setOfflineBannerHeight`, so the reservation always
 * matches the real bar at any font scale instead of guessing a constant.
 *
 * Kept separate from `offline-banner-state.ts` (connectivity) on purpose: this
 * is a layout channel, not part of the confirmed-offline decision.
 */
let height = 0;
const listeners = new Set<() => void>();

export function setOfflineBannerHeight(next: number): void {
  if (next === height) {
    return;
  }
  height = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getOfflineBannerHeight(): number {
  return height;
}

export function subscribeOfflineBannerHeight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
