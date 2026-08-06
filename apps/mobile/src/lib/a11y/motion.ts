import { useReducedMotion } from 'react-native-reanimated';

// Centralized reduced-motion policy (P3-C-05, D15). Imperative scrolls go
// immediate when the system Reduce Motion setting is on. Action-sheet
// presentation stays with the library and the OS: a sheet's own slide-in is
// essential presentation motion, outside WCAG 2.3.3's non-essential scope.

export type MotionPolicy = {
  reduceMotion: boolean;
  /** `false` when reduce motion is on, so imperative scrolls go immediate. */
  scrollAnimated: boolean;
};

/** Wrap Reanimated's `useReducedMotion` in the app's motion vocabulary. */
export function useMotionPolicy(): MotionPolicy {
  const reduceMotion = useReducedMotion();
  return {
    reduceMotion,
    scrollAnimated: !reduceMotion,
  };
}
