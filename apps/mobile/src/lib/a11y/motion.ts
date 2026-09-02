import { useReducedMotion } from 'react-native-reanimated';

// Centralized reduced-motion policy (P3-C-05, D15). Imperative scrolls go
// immediate when the system Reduce Motion setting is on. Action-sheet
// presentation stays with the library and the OS: a sheet's own slide-in is
// essential presentation motion, outside WCAG 2.3.3's non-essential scope.
// The composer's springs, pulses, shake, send-to-stop morph, and height
// transitions must become instant or a plain crossfade under the same policy.

export type MotionPolicy = {
  /** `false` when reduce motion is on, so imperative scrolls go immediate. */
  scrollAnimated: boolean;
  /** `true` when the system Reduce Motion setting is on. */
  reducedMotion: boolean;
};

/** Wrap Reanimated's `useReducedMotion` in the app's motion vocabulary. */
export function useMotionPolicy(): MotionPolicy {
  const reducedMotion = useReducedMotion();
  return { scrollAnimated: !reducedMotion, reducedMotion };
}

/** Pick an instant or crossfade entrance for an optional overlay under the policy. */
export function selectReducedMotionEntrance<T>(
  reducedMotion: boolean,
  crossfade: T
): T | undefined {
  return reducedMotion ? undefined : crossfade;
}
