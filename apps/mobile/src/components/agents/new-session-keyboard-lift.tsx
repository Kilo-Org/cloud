import { type ReactNode } from 'react';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useKeyboardMotionProgress } from '@/components/keyboard-motion-provider';

/**
 * The body and the pinned footer, lifted by the keyboard's height.
 *
 * The screen's `KeyboardAvoidingView` was removed here because the library
 * derives its lift from a frame it receives from an async native call: when
 * that call had not landed before the frame was stored, the frame kept the
 * parent-relative zero, and the lift fell short by the container's own top.
 * The whole pinned footer — the reason line and Start — stayed behind the
 * keyboard.
 *
 * `height` is the height the keyboard will occupy, from `useKeyboardState`,
 * which is the same value the form's own frame fit reads. `progress` is the
 * keyboard's animation position from `KeyboardMotionProvider`, so the padding
 * reaches that height exactly as the keyboard lands and returns to zero as it
 * leaves, on the UI thread and without a layout pass in between.
 */
export function NewSessionKeyboardLift({
  height,
  children,
}: Readonly<{ height: number; children: ReactNode }>) {
  const progress = useKeyboardMotionProgress();
  const liftStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, height) * Math.max(0, Math.min(1, progress.value)),
  }));
  return (
    <Animated.View className="flex-1 bg-background" style={liftStyle}>
      {children}
    </Animated.View>
  );
}
