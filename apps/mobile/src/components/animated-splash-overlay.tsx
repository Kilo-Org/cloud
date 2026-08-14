import * as SplashScreen from 'expo-splash-screen';
import { TimeToFullDisplay } from '@sentry/react-native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';
import { isStartupComplete, subscribeStartupComplete } from '@/lib/startup-timing';

const EXIT_BG_MS = 250;
const EXIT_LOGO_MS = 300;
const HIDE_SAFETY_MS = 2000;
const LOGO_LOAD_SAFETY_MS = 500;

export function AnimatedSplashOverlay() {
  const complete = useSyncExternalStore(subscribeStartupComplete, isStartupComplete);
  // Fast-refresh / test guard: if startup already completed before mount, never
  // paint the yellow frame again.
  const [dismissed, setDismissed] = useState(() => isStartupComplete());
  const [logoLoaded, setLogoLoaded] = useState(false);
  const [logoWaived, setLogoWaived] = useState(false);
  const reducedMotion = useReducedMotion();
  const bgOpacity = useSharedValue(1);
  const logoScale = useSharedValue(1);
  const logoOpacity = useSharedValue(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLogoWaived(true);
    }, LOGO_LOAD_SAFETY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!complete || dismissed || !(logoLoaded || logoWaived)) {
      return undefined;
    }
    let cancelled = false;
    const finish = () => {
      setDismissed(true);
    };

    async function hideAndExit() {
      try {
        // Same fire-and-forget contract as the old `void hideAsync()`; the race
        // bounds a wedged native call.
        await Promise.race([
          SplashScreen.hideAsync(),
          new Promise(resolve => {
            setTimeout(resolve, HIDE_SAFETY_MS);
          }),
        ]);
      } catch {
        // Ignore — parity with today's behavior.
      }
      if (cancelled) {
        return;
      }
      if (reducedMotion) {
        finish();
        return;
      }
      bgOpacity.value = withTiming(0, { duration: EXIT_BG_MS });
      logoScale.value = withTiming(1.4, { duration: EXIT_LOGO_MS });
      logoOpacity.value = withTiming(0, { duration: EXIT_LOGO_MS }, finished => {
        if (finished) {
          scheduleOnRN(finish);
        }
      });
    }

    void hideAndExit();
    return () => {
      cancelled = true;
    };
  }, [
    complete,
    dismissed,
    logoLoaded,
    logoWaived,
    reducedMotion,
    bgOpacity,
    logoScale,
    logoOpacity,
  ]);

  const bgStyle = useAnimatedStyle(() => ({ opacity: bgOpacity.value }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  return (
    <>
      {/* TTFD means "the launch's final frame is visible": record after the overlay
          is gone, for every outcome — error screens are the launch's full display too. */}
      <TimeToFullDisplay record={dismissed} />
      {dismissed ? null : (
        <Animated.View pointerEvents="none" className="absolute inset-0">
          <Animated.View className="absolute inset-0 bg-[#FAF74F]" style={bgStyle} />
          <Animated.View className="absolute inset-0 items-center justify-center" style={logoStyle}>
            <Image
              source={logo}
              className="h-[100px] w-[100px]"
              transition={0}
              onLoad={() => {
                setLogoLoaded(true);
              }}
            />
          </Animated.View>
        </Animated.View>
      )}
    </>
  );
}
