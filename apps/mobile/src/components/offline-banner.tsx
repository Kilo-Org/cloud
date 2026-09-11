import { WifiOff } from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { announceForA11y } from '@/lib/a11y/announce';
import { setOfflineBannerHeight } from '@/lib/offline-banner-layout';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';

/**
 * App-wide offline banner. Absolute overlay, so app content below the header
 * keeps its layout position; `pointerEvents="none"` passes every touch to the
 * header below. The header is the one thing the overlay would otherwise
 * paint over (SPOT-DEFECT e6: the bar clipped the "New session" title), so
 * the banner reports its rendered height through `setOfflineBannerHeight` and
 * `ScreenHeader` reserves exactly that space while it is visible.
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

  // Headers reserve the space this overlay paints into. Clear the shared
  // reservation whenever the bar is hidden or unmounts; while it is shown,
  // `onLayout` reports the rendered height, so the reservation matches the
  // real bar at any font scale instead of guessing a constant.
  useEffect(() => {
    if (!isOffline) {
      setOfflineBannerHeight(0);
    }
    return () => {
      setOfflineBannerHeight(0);
    };
  }, [isOffline]);

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
        onLayout={(event: LayoutChangeEvent) => {
          setOfflineBannerHeight(event.nativeEvent.layout.height);
        }}
        className="flex-row items-center justify-center gap-2 bg-warn px-4 py-2"
      >
        <WifiOff size={14} color={colors.warnForeground} />
        <Text className="text-sm font-medium text-warn-foreground">{t('offline.noInternet')}</Text>
      </Animated.View>
    </View>
  );
}
