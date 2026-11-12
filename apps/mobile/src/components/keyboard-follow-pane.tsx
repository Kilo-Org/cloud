import { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardMotionHeight } from '@/components/keyboard-motion-provider';

const CLIP: ViewStyle = { flex: 1, overflow: 'hidden' };
const PANE: ViewStyle = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

/**
 * Lifts its children with the keyboard without changing their layout.
 *
 * A keyboard-avoiding container that resizes its children reports a new layout
 * on every keyboard frame, and a list inside it re-pins its tail from those
 * events: the transcript then moves in a handful of discrete steps while the
 * keyboard moves smoothly. This pane keeps the frame constant and translates
 * the content on the UI thread by the keyboard's own height, so the list sees
 * one layout and the content rides the keyboard frame by frame.
 *
 * The parent clips, so the part of the pane that lifts above the screen edge
 * (a header's worth) is hidden instead of painting over the content above it.
 */
export function KeyboardFollowPane({ children }: Readonly<{ children: ReactNode }>) {
  const keyboardHeight = useKeyboardMotionHeight();
  // The pane's bottom edge already clears the safe-area inset that the screen
  // reserves below it, so the keyboard only has to lift the rest.
  const { bottom } = useSafeAreaInsets();
  const lift = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, keyboardHeight.value - bottom) }],
  }));

  return (
    <View style={CLIP}>
      <Animated.View style={[PANE, lift]}>{children}</Animated.View>
    </View>
  );
}
