import { BlurView } from 'expo-blur';
import { type ReactNode, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, useColorScheme, View } from 'react-native';

import { cn } from '@/lib/utils';

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

/** True means solid fallback: non-iOS, unknown, enabled, or a read failure. */
function getSnapshot(): boolean {
  return Platform.OS !== 'ios' || reduced !== false;
}

/**
 * Translucent bar background. iOS uses `expo-blur`; Android and web fall back
 * to a solid card surface because BlurView performance on low-end Android is
 * unreliable. iOS Reduce Transparency also forces the solid surface. The outer
 * `View` stays mounted across the switch so children never remount.
 */
export function BlurBar({ children, className, intensity = 40 }: Readonly<BlurBarProps>) {
  const scheme = useColorScheme();
  const solid = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <View
      className={cn(
        'overflow-hidden border-t-[0.5px] border-border',
        className,
        solid && 'bg-background'
      )}
    >
      {!solid && (
        <BlurView
          intensity={intensity}
          tint={scheme === 'dark' ? 'dark' : 'light'}
          className="absolute inset-0"
        />
      )}
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
