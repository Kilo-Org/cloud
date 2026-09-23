import { BlurView } from 'expo-blur';
// Liquid Glass is an Apple-only material: expo-glass-effect ships just an
// `apple` native module, and its capability probes below return false on
// Android. The component therefore selects the material from the capability,
// not from `Platform.OS`, and keeps a fallback for the platform that has no
// equivalent capability.
import {
  type GlassEffectStyleConfig,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { styled } from 'nativewind';
import { type ComponentType, type ReactNode, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  Platform,
  type StyleProp,
  useColorScheme,
  View,
  type ViewStyle,
} from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';
import { cn } from '@/lib/utils';

// `className` is only interop-mapped for `react-native` primitives, so a native
// expo view needs the same `styled` wrapper the app already uses for expo-image
// (see image.tsx). `styled` cannot expand `GlassView`'s `glassEffectStyle` union
// through its prop mapping (TS2590), so the wrapper is pinned to the props this
// component passes.
type GlassViewPrimitiveProps = {
  className?: string;
  colorScheme?: 'dark' | 'light';
  glassEffectStyle?: GlassEffectStyleConfig;
  style?: StyleProp<ViewStyle>;
};
const GlassViewPrimitive: ComponentType<GlassViewPrimitiveProps> = GlassView;
const StyledGlassView = styled(GlassViewPrimitive, { className: 'style' });

type BlurBarProps = {
  children: ReactNode;
  className?: string;
  intensity?: number;
};

/** Native Reduce Transparency preference. `undefined` until the first read. */
let reduced: boolean | undefined = undefined;

/** Bumps on every start, stop, and change event so a stale read cannot apply. */
let generation = 0;

const listeners = new Set<() => void>();
let eventSubscription: { remove: () => void } | undefined = undefined;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function startReduceTransparencyTracking(): void {
  generation += 1;
  const current = generation;
  void (async () => {
    // A failed read must not leave the bar translucent on iOS.
    const next = await AccessibilityInfo.isReduceTransparencyEnabled().catch(() => true);
    if (generation !== current) {
      return;
    }
    reduced = next;
    emitChange();
  })();
  eventSubscription = AccessibilityInfo.addEventListener(
    'reduceTransparencyChanged',
    (value: boolean) => {
      generation += 1;
      reduced = value;
      emitChange();
    }
  );
}

function stopReduceTransparencyTracking(): void {
  generation += 1;
  reduced = undefined;
  eventSubscription?.remove();
  eventSubscription = undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (Platform.OS === 'ios' && listeners.size === 1) {
    startReduceTransparencyTracking();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopReduceTransparencyTracking();
    }
  };
}

/**
 * True means solid fallback: unknown, enabled, a read failure, or a platform
 * without a dependable blur capability — Android has no equivalent of the
 * `expo-blur` rendering here (BlurView performance on low-end Android is
 * unreliable), so the bar is a solid card surface there.
 */
function getSnapshot(): boolean {
  return Platform.OS !== 'ios' || reduced !== false;
}

/**
 * Translucent bar background. `isLiquidGlassAvailable()` is the cross-platform
 * capability probe for the native `expo-glass-effect` Liquid Glass material:
 * it is true only where that material exists (iOS 26 and up), and the material
 * has no Android equivalent, so the capability alone selects it and no
 * `Platform.OS` test is needed. Every other translucent path keeps `expo-blur`;
 * Android and iOS Reduce Transparency use the solid card surface — Android
 * because BlurView performance on low-end Android is unreliable. The outer
 * `View` stays mounted across the switch so children never remount.
 */
export function BlurBar({ children, className, intensity = 40 }: Readonly<BlurBarProps>) {
  const scheme = useColorScheme();
  const solid = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { reducedMotion } = useMotionPolicy();
  // The capability probe, not `Platform.OS`, decides: it is false on Android
  // (see the import comment) and on every iOS version without the material.
  // iOS 26 betas without the `UIGlassEffect` API crash on `GlassView`
  // (expo/expo#40911), so `isGlassEffectAPIAvailable()` must also be true or
  // the blur fallback stays. `isLiquidGlassAvailable()` alone is not enough.
  const glass = !solid && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  // Kept out of the JSX so `react-native/no-inline-styles` does not read the
  // `style` key of the glass config as an inline style.
  const glassEffectStyle = { style: 'regular' as const, animate: !reducedMotion };
  return (
    <View
      className={cn(
        'overflow-hidden border-t-[0.5px] border-border',
        className,
        solid && 'bg-background'
      )}
    >
      {!solid &&
        (glass ? (
          <StyledGlassView
            className="absolute inset-0"
            colorScheme={scheme === 'dark' ? 'dark' : 'light'}
            glassEffectStyle={glassEffectStyle}
          />
        ) : (
          <BlurView
            intensity={intensity}
            tint={scheme === 'dark' ? 'dark' : 'light'}
            className="absolute inset-0"
          />
        ))}
      {children}
    </View>
  );
}

/** Test-only: reset in-memory state between cases. */
export function __resetBlurBarForTests(): void {
  eventSubscription?.remove();
  eventSubscription = undefined;
  listeners.clear();
  generation = 0;
  reduced = undefined;
}
