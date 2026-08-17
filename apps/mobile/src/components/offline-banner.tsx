import { WifiOff } from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { announceForA11y } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';

/**
 * App-wide offline banner. Absolute overlay, so app content keeps its layout
 * position; `pointerEvents="none"` passes every touch to the header below.
 */
export function OfflineBanner() {
  const isOffline = useOfflineBannerState();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const prevRef = useRef<boolean | null>(null);

  // Announce committed transitions only, never the initial state: the first
  // run records the current value without announcing. A cold-start offline
  // device announces once when the first NetInfo commit lands, one
  // OFFLINE_BANNER_SHOW_DELAY_MS after launch.
  useEffect(() => {
    if (prevRef.current !== null && prevRef.current !== isOffline) {
      announceForA11y(isOffline ? 'No internet connection' : 'Internet connection restored');
    }
    prevRef.current = isOffline;
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
        accessibilityLabel="No internet connection"
        className="flex-row items-center justify-center gap-2 bg-warn px-4 py-2"
      >
        <WifiOff size={14} color={colors.warnForeground} />
        <Text className="text-sm font-medium text-warn-foreground">No internet connection</Text>
      </Animated.View>
    </View>
  );
}
