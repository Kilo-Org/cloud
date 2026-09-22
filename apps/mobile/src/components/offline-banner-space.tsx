import { createContext, type PropsWithChildren, useContext } from 'react';

// The banner is an absolute overlay pinned at the safe-area top, so a pinned
// `ScreenHeader` must reserve its height while it is visible or the overlay
// covers the header title (uxs2 spot check e6-offline-hang; gr2 spot check
// e6-offline-nav, Profile). The app root supplies the value from the shared
// offline-banner store. The default is `false`, so a header rendered without
// the provider (tests, isolated surfaces) keeps its natural geometry.
const OfflineBannerSpaceContext = createContext(false);

export function OfflineBannerSpaceProvider({
  isOffline,
  children,
}: Readonly<PropsWithChildren<{ isOffline: boolean }>>) {
  return (
    <OfflineBannerSpaceContext.Provider value={isOffline}>
      {children}
    </OfflineBannerSpaceContext.Provider>
  );
}

/** True while the app-wide offline banner is painted over the top of the window. */
export function useOfflineBannerSpace(): boolean {
  return useContext(OfflineBannerSpaceContext);
}
