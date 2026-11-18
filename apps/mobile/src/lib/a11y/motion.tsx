import { BatteryState, useBatteryLevel, useBatteryState } from 'expo-battery';
import { type ReactNode, useMemo } from 'react';
import { ReducedMotionConfig, ReduceMotion, useReducedMotion } from 'react-native-reanimated';

import {
  MotionContext,
  type MotionPolicy,
  useProvidedMotionPolicy,
} from '@/lib/a11y/motion-context';

export type { MotionPolicy } from '@/lib/a11y/motion-context';

// Centralized reduced-motion policy (P3-C-05, D15). Imperative scrolls go
// immediate when the system Reduce Motion setting is on. Action-sheet
// presentation stays with the library and the OS: a sheet's own slide-in is
// essential presentation motion, outside WCAG 2.3.3's non-essential scope.
// The composer's springs, pulses, shake, send-to-stop morph, and height
// transitions must become instant or a plain crossfade under the same policy.

/** Enable low battery mode only for a known, unpowered reading below 20%. */
function selectLowBatteryMode(batteryLevel: number, batteryState: BatteryState): boolean {
  return (
    batteryLevel >= 0 &&
    batteryLevel < 0.2 &&
    (batteryState === BatteryState.UNPLUGGED || batteryState === BatteryState.NOT_CHARGING)
  );
}

export function MotionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const batteryLevel = useBatteryLevel();
  const batteryState = useBatteryState();
  const systemReducedMotion = useReducedMotion();
  const lowBatteryMode = selectLowBatteryMode(batteryLevel, batteryState);
  const reducedMotion = systemReducedMotion || lowBatteryMode;
  const policy = useMemo(
    () => ({ reducedMotion, scrollAnimated: !reducedMotion }),
    [reducedMotion]
  );

  return (
    <MotionContext.Provider value={policy}>
      <ReducedMotionConfig mode={lowBatteryMode ? ReduceMotion.Always : ReduceMotion.System} />
      {children}
    </MotionContext.Provider>
  );
}

/** Read the shared policy, or the system setting before the provider mounts. */
export function useMotionPolicy(): MotionPolicy {
  const policy = useProvidedMotionPolicy();
  const systemReducedMotion = useReducedMotion();
  return policy ?? { scrollAnimated: !systemReducedMotion, reducedMotion: systemReducedMotion };
}

/** Pick an instant or crossfade entrance for an optional overlay under the policy. */
export function selectReducedMotionEntrance<T>(
  reducedMotion: boolean,
  crossfade: T
): T | undefined {
  return reducedMotion ? undefined : crossfade;
}
