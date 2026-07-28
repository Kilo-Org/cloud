import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { cn } from '@/lib/utils';

export type StatusDotTone = 'good' | 'warn' | 'danger' | 'muted';

type StatusDotProps = {
  tone?: StatusDotTone;
  className?: string;
  /** Soft opacity breathe on the dot+halo. Static when reduced motion is on. */
  pulse?: boolean;
};

// Solid inner-dot and outer-halo classes per tone. The halo uses the
// pre-tinted Focus tile tokens because `/opacity` does not work with our
// CSS-variable theme tokens.
const TONE: Record<StatusDotTone, { dot: string; halo: string }> = {
  good: { dot: 'bg-good', halo: 'bg-good-tile-bg' },
  warn: { dot: 'bg-warn', halo: 'bg-warn-tile-bg' },
  danger: { dot: 'bg-destructive', halo: 'bg-danger-tile-bg' },
  muted: { dot: 'bg-muted-soft', halo: 'bg-neutral-500/20' },
};

// Soft breathe range and cadence. Mirrors the provisioning-step pulse
// pattern: 1.0 (fully visible) down to ~0.45 (faded), reversed, looping.
const PULSE_LOW = 0.45;
const PULSE_DURATION_MS = 1100;

/**
 * Status indicator dot with a halo (replaces CSS box-shadow).
 * 7px inner dot centered inside a 13px halo.
 *
 * When `pulse` is true, the entire dot+halo softly breathes via opacity —
 * never a hard on/off blink. Respects `useReducedMotion()` and renders
 * statically (fully visible) when motion is reduced.
 */
export function StatusDot({ tone = 'good', className, pulse = false }: Readonly<StatusDotProps>) {
  const styles = TONE[tone];

  // Animated branch: opacity breathe on the wrapper so the inner dot and
  // halo fade together. Static when reduced motion is on.
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    // Only the pulsing branch animates. Non-pulsing dots (every existing
    // caller) must not start a perpetual invisible animation, and reduced
    // motion keeps the dot fully visible.
    if (!pulse || reducedMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return undefined;
    }
    opacity.value = withRepeat(
      withTiming(PULSE_LOW, {
        duration: PULSE_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true
    );
    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity, pulse, reducedMotion]);
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  if (pulse) {
    return (
      <Animated.View
        className={cn(
          'h-[13px] w-[13px] items-center justify-center rounded-full',
          styles.halo,
          className
        )}
        style={pulseStyle}
      >
        <View className={cn('h-[7px] w-[7px] rounded-full', styles.dot)} />
      </Animated.View>
    );
  }

  return (
    <View
      className={cn(
        'h-[13px] w-[13px] items-center justify-center rounded-full',
        styles.halo,
        className
      )}
    >
      <View className={cn('h-[7px] w-[7px] rounded-full', styles.dot)} />
    </View>
  );
}
