import { useSegments } from 'expo-router';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { type ReactElement, useEffect } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { isPrivacyCoverRoute } from '@/lib/privacy-cover';
import { emitPrivacyCover } from '@/lib/privacy-cover-events';

type PrivacyCoverOverlayProps = {
  segments: readonly string[];
};

/** Own key, so another caller's `allowScreenCaptureAsync()` cannot lift ours. */
const CAPTURE_KEY = 'privacy-cover';

async function ignoreCaptureFailure(call: Promise<void>): Promise<void> {
  try {
    await call;
  } catch {
    // Unsupported platform or native failure: keep the OS default.
  }
}

/**
 * Blocks screen capture for as long as the route stays covered. Prevent runs on
 * mount and allow runs in the effect cleanup, so React pairs and orders the two
 * native calls itself: the cleanup always runs before the next effect body, and
 * a fast route flip can no longer land a late `allow` after a live `prevent`.
 *
 * Android only. On iOS `preventScreenCaptureAsync` re-parents keyWindow.layer
 * under a secure UITextField, which blanks screenshots but stops native
 * UIAlertController presentation (the markdown link host-confirm Alert never
 * appears on covered routes) and still does not blank the Recents preview.
 */
function useCaptureBlock(covered: boolean): void {
  const blocked = Platform.OS === 'android' && covered;
  useEffect(() => {
    if (!blocked) {
      return undefined;
    }
    void ignoreCaptureFailure(preventScreenCaptureAsync(CAPTURE_KEY));
    return () => {
      void ignoreCaptureFailure(allowScreenCaptureAsync(CAPTURE_KEY));
    };
  }, [blocked]);
}

/**
 * Full-bleed cover that turns fully opaque in the same AppState listener frame
 * the app leaves `active`, so the OS captures only the solid background when it
 * snapshots the app for Recents / the app switcher. `pointerEvents="none"`
 * always, so the cover never blocks navigation.
 */
function CoverView({
  covered,
  onCover,
}: Readonly<{ covered: boolean; onCover?: () => void }>): ReactElement {
  const opacity = useSharedValue(0);

  useEffect(() => {
    const handleChange = (nextState: AppStateStatus) => {
      if (covered && nextState !== 'active') {
        onCover?.();
        opacity.value = 1;
      } else if (nextState === 'active') {
        opacity.value = 0;
      }
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, [covered, onCover, opacity]);

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

/**
 * Root cover: blanks the tree on a covered route, closes every opted-in native
 * Modal in the same frame, and blocks screen capture while the route stays
 * covered.
 */
export function PrivacyCoverOverlay({ segments }: Readonly<PrivacyCoverOverlayProps>) {
  const covered = isPrivacyCoverRoute(segments);
  useCaptureBlock(covered);
  return <CoverView covered={covered} onCover={emitPrivacyCover} />;
}

/**
 * Per-screen twin of the root cover. iOS presents a `formSheet` / `modal` route
 * as its own view controller above the root view, so the root cover — and any
 * other view mounted in the root tree — draws behind it. This one lives inside
 * the presented screen's own tree, so it blanks that screen.
 *
 * Pass it as `screenLayout` on every Stack inside the profile tab that
 * declares a sheet route. It costs nothing on an uncovered route, so it is set
 * per navigator rather than per screen.
 */
export function privacyScreenLayout({
  children,
}: Readonly<{ children: ReactElement }>): ReactElement {
  return (
    <>
      {children}
      <PrivacySheetCover />
    </>
  );
}

function PrivacySheetCover(): ReactElement {
  const segments = useSegments();
  return <CoverView covered={isPrivacyCoverRoute(segments)} />;
}
