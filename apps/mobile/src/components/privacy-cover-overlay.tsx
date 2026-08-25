import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { isPrivacyCoverRoute } from '@/lib/privacy-cover';
import { emitPrivacyCover } from '@/lib/privacy-cover-events';

type PrivacyCoverOverlayProps = {
  segments: readonly string[];
};

/**
 * Sibling overlay that blanks the tree whenever the active route is covered
 * and the app leaves `active`. In the same AppState listener frame it turns
 * fully opaque, so the OS captures only the solid background when it snapshots
 * the app for Recents / the app switcher. `pointerEvents="none"` always, so the
 * overlay never blocks navigation.
 */
export function PrivacyCoverOverlay({ segments }: Readonly<PrivacyCoverOverlayProps>) {
  const covered = isPrivacyCoverRoute(segments);
  const opacity = useSharedValue(0);

  // FLAG_SECURE (Android Recents blank) / screenshot+recording block (iOS)
  // follows the route, not the lifecycle.
  useEffect(() => {
    void (async () => {
      try {
        await (covered ? preventScreenCaptureAsync() : allowScreenCaptureAsync());
      } catch {
        // Unsupported platform or native failure: keep the OS default.
      }
    })();
  }, [covered]);

  useEffect(() => {
    const handleChange = (nextState: AppStateStatus) => {
      if (covered && nextState !== 'active') {
        // Close any open native Modal first: cover or not, it renders above us.
        emitPrivacyCover();
        opacity.value = 1;
      } else if (nextState === 'active') {
        opacity.value = 0;
      }
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, [covered, opacity]);

  const coverStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-0 bg-background"
      style={coverStyle}
    />
  );
}
