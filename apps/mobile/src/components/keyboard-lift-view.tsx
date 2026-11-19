import { type ReactNode } from 'react';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useKeyboardMotionProgress } from '@/components/keyboard-motion-provider';

/**
 * A bottom-anchored surface that lifts by `height` as the keyboard lands.
 *
 * The library's `KeyboardAvoidingView` derives its lift from a frame it receives
 * from an async native call: when that call had not landed before the frame was
 * stored, the frame kept the parent-relative zero and the lift fell short by the
 * container's own top, so a pinned footer stayed behind the keyboard. This view
 * pads by a height the screen can compute from the keyboard state it already
 * reads, and animates it with the keyboard's own motion progress, so the surface
 * reaches the requested height exactly as the keyboard lands and returns to zero
 * as it leaves — on the UI thread, with no layout pass in between.
 *
 * `height` is the padding the surface wants while the keyboard is fully open;
 * the screen subtracts whatever its own bottom padding already covers.
 */
export function KeyboardLiftView({
  height,
  className,
  children,
}: Readonly<{ height: number; className?: string; children: ReactNode }>) {
  const progress = useKeyboardMotionProgress();
  const liftStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, height) * Math.max(0, Math.min(1, progress.value)),
  }));
  return (
    <Animated.View className={className} style={liftStyle}>
      {children}
    </Animated.View>
  );
}
