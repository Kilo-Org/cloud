import { WifiOff } from '@/components/ui/icons';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  OFFLINE_BANNER_HEIGHT,
  OfflineBannerSpaceProvider,
} from '@/components/offline-banner-space';
import { Text } from '@/components/ui/text';
import { announceForA11y } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';

// Re-exported for existing callers/tests; the constant is defined in the leaf
// `offline-banner-space` module so `ScreenHeader` can reserve the height
// without loading this component's dependencies.
export { OFFLINE_BANNER_HEIGHT };

/**
 * Publishes the banner's visibility to every pinned `ScreenHeader`. Mounted by
 * the root layout above the navigation tree; the header then reserves the
 * overlay's height without importing the connectivity stack itself.
 */
export function OfflineBannerSpaceGate({ children }: Readonly<{ children: ReactNode }>) {
  const isOffline = useOfflineBannerState();
  return <OfflineBannerSpaceProvider isOffline={isOffline}>{children}</OfflineBannerSpaceProvider>;
}

/**
 * App-wide offline banner. Absolute overlay, so app content keeps its layout
 * position; `pointerEvents="none"` passes every touch to the header below.
 * Surfaces with a pinned top header reserve `OFFLINE_BANNER_HEIGHT` above the
 * header while the banner is visible so it never covers the title.
 */
export function OfflineBanner() {
  const isOffline = useOfflineBannerState();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const prevRef = useRef<boolean | null>(null);

  // Announce committed transitions only, never the initial state: the first
  // run records the current value without announcing. A cold-start offline
  // device announces once when the first NetInfo commit lands, one
  // OFFLINE_BANNER_SHOW_DELAY_MS after launch.
  useEffect(() => {
    if (prevRef.current !== null && prevRef.current !== isOffline) {
      announceForA11y(isOffline ? t('offline.noInternet') : t('offline.internetRestored'));
    }
    prevRef.current = isOffline;
  }, [isOffline, t]);

  if (!isOffline) {
    return null;
  }

  return (
    // Dynamic safe-area values cannot be Tailwind classes; same inline-style
    // exception as `ScreenHeader` (style={{ paddingTop }}).
    <View pointerEvents="none" className="absolute inset-x-0" style={{ top: insets.top }}>
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={t('offline.noInternet')}
        className="flex-row items-center justify-center gap-2 bg-warn px-4"
        style={{ height: OFFLINE_BANNER_HEIGHT }}
      >
        <WifiOff size={14} color={colors.warnForeground} />
        <Text className="text-sm font-medium text-warn-foreground">{t('offline.noInternet')}</Text>
      </Animated.View>
    </View>
  );
}
