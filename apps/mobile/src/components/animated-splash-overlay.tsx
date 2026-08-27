import * as SplashScreen from 'expo-splash-screen';
import { TimeToFullDisplay } from '@sentry/react-native';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';
import { SPLASH_CONTENT_OVERSCAN, splashContentScale } from '@/components/splash-reveal';
import { isStartupComplete, subscribeStartupComplete } from '@/lib/startup-timing';

const HIDE_SAFETY_MS = 2000;
const LOGO_LOAD_SAFETY_MS = 500;
const REVEAL_START_SAFETY_MS = 1000;

// Reveal timeline. The logo dips, punches through the viewer and clears the
// frame, and only then does a disc of the app's own background wipe the yellow
// away and hand over to the live tree. The logo must finish before the disc
// overtakes it: `logo.png` carries its own yellow tile, which would otherwise
// show as a square against the revealed background.
const DIP_MS = 100;
const DIP_SCALE = 0.9;
const PUNCH_DELAY_MS = 100;
const PUNCH_MS = 180;
const PUNCH_SCALE = 1.5;
const DISC_DELAY_MS = 280;
const DISC_MS = 320;
const HANDOVER_DELAY_MS = 480;
const HANDOVER_MS = 170;
/**
 * How far the 120dp reveal disc grows. 16x clears the diagonal of every phone
 * and tablet this app runs on, so the disc never leaves a yellow wedge in a
 * corner; a fixed factor keeps the overlay free of any layout dependency. The
 * growth is linear so the wipe's leading edge crosses the screen at a steady
 * speed instead of shooting off in the first few frames.
 */
const DISC_COVER_SCALE = 16;
/**
 * Longest gap that still counts as a rendered frame, at 60Hz plus slack. A
 * longer gap means the render thread is still busy with the handover.
 */
const HEALTHY_FRAME_MS = 34;

export function AnimatedSplashOverlay() {
  const complete = useSyncExternalStore(subscribeStartupComplete, isStartupComplete);
  // Fast-refresh / test guard: if startup already completed before mount, never
  // paint the yellow frame again.
  const [dismissed, setDismissed] = useState(() => isStartupComplete());
  const [logoLoaded, setLogoLoaded] = useState(false);
  const [logoWaived, setLogoWaived] = useState(false);
  const exitStartedRef = useRef(false);
  const reducedMotion = useReducedMotion();
  const overlayOpacity = useSharedValue(1);
  const discScale = useSharedValue(0);
  const logoScale = useSharedValue(1);
  const logoOpacity = useSharedValue(1);
  const revealStarted = useSharedValue(false);

  const startReveal = useCallback(() => {
    'worklet';
    logoScale.value = withSequence(
      withTiming(DIP_SCALE, { duration: DIP_MS, easing: Easing.out(Easing.quad) }),
      withTiming(PUNCH_SCALE, { duration: PUNCH_MS, easing: Easing.in(Easing.cubic) })
    );
    logoOpacity.value = withDelay(PUNCH_DELAY_MS, withTiming(0, { duration: PUNCH_MS }));
    discScale.value = withDelay(
      DISC_DELAY_MS,
      withTiming(DISC_COVER_SCALE, { duration: DISC_MS, easing: Easing.linear })
    );
    splashContentScale.value = withDelay(
      HANDOVER_DELAY_MS,
      withTiming(1, { duration: HANDOVER_MS, easing: Easing.out(Easing.cubic) })
    );
    overlayOpacity.value = withDelay(
      HANDOVER_DELAY_MS,
      withTiming(0, { duration: HANDOVER_MS }, finished => {
        if (finished) {
          scheduleOnRN(setDismissed, true);
        }
      })
    );
  }, [discScale, logoOpacity, logoScale, overlayOpacity]);

  // Hiding the native splash uncovers the whole app tree, and compositing it
  // costs a few hundred milliseconds on a cold start. Reanimated drives the
  // reveal off the render clock, so starting it in the same tick spends that
  // time on frames nobody sees: the first painted frame lands a third of the
  // way in, and the logo appears to jump to a smaller size. Wait for a frame
  // the device actually rendered. The overlay is pixel-identical to the native
  // splash, so the wait is invisible.
  const frameCallback = useFrameCallback(({ timeSincePreviousFrame }) => {
    'worklet';
    if (revealStarted.value) {
      return;
    }
    if (timeSincePreviousFrame === null || timeSincePreviousFrame > HEALTHY_FRAME_MS) {
      return;
    }
    revealStarted.value = true;
    startReveal();
  }, false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLogoWaived(true);
    }, LOGO_LOAD_SAFETY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!complete || dismissed || !(logoLoaded || logoWaived) || exitStartedRef.current) {
      return undefined;
    }
    let safety: ReturnType<typeof setTimeout> | undefined = undefined;

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
      if (reducedMotion) {
        setDismissed(true);
        return;
      }
      // The tree is already mounted behind the disc, so the overscan is set
      // before the wait and only its settle is visible.
      splashContentScale.value = SPLASH_CONTENT_OVERSCAN;
      frameCallback.setActive(true);
      // A device that never reports a healthy frame must not strand the
      // overlay on screen.
      safety = setTimeout(() => {
        if (!revealStarted.value) {
          revealStarted.value = true;
          startReveal();
        }
      }, REVEAL_START_SAFETY_MS);
    }

    exitStartedRef.current = true;
    void hideAndExit();
    return () => {
      clearTimeout(safety);
      frameCallback.setActive(false);
    };
  }, [
    complete,
    dismissed,
    logoLoaded,
    logoWaived,
    reducedMotion,
    frameCallback,
    revealStarted,
    startReveal,
  ]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlayOpacity.value }));
  const discStyle = useAnimatedStyle(() => ({ transform: [{ scale: discScale.value }] }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  return (
    <>
      {/* TTFD means "the launch's final frame is visible": record after the overlay
          is gone, for every outcome — error screens are the launch's full display too. */}
      <TimeToFullDisplay ready={dismissed} />
      {dismissed ? null : (
        <Animated.View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center bg-[#FAF74F]"
          style={overlayStyle}
        >
          <Animated.View
            className="absolute h-[120px] w-[120px] rounded-full bg-background"
            style={discStyle}
          />
          <Animated.View style={logoStyle}>
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
