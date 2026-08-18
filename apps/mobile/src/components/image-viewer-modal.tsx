import { Share, X } from '@/components/ui/icons';
import { useEffect } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ImageViewerModalProps = {
  visible: boolean;
  uri: string | null;
  /** Header a11y labels; kilo-chat passes the filename. */
  filename: string;
  /** Omit to hide the share action entirely. */
  onShare?: () => void;
  sharing?: boolean;
  /** Share failure message. Rendered inline — the toast layer sits behind this modal. */
  shareError?: string | null;
  onClose: () => void;
};

export function ImageViewerModal({
  visible,
  uri,
  filename,
  sharing = false,
  shareError = null,
  onClose,
  onShare,
}: ImageViewerModalProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  function resetZoom() {
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
  }

  // Reopening must start at 1x.
  useEffect(() => {
    if (!visible) {
      scale.value = 1;
      savedScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedX.value = 0;
      savedY.value = 0;
    }
  }, [visible, scale, savedScale, translateX, translateY, savedX, savedY]);

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Pinch().
  const pinch = Gesture.Pinch()
    .onUpdate(event => {
      scale.value = savedScale.value * event.scale;
    })
    .onEnd(() => {
      const next = Math.min(Math.max(scale.value, 1), 5);
      scale.value = withTiming(next);
      savedScale.value = next;
      if (next === 1) {
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Pan().
  const pan = Gesture.Pan()
    .onUpdate(event => {
      // Panning is only meaningful once zoomed in; at 1x the image fills the frame.
      if (savedScale.value <= 1) {
        return;
      }
      translateX.value = savedX.value + event.translationX;
      translateY.value = savedY.value + event.translationY;
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Tap().
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scheduleOnRN(resetZoom);
    });

  // Pinch and pan run together; the double-tap races them so a two-finger
  // gesture is never swallowed by tap detection.
  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Race/Simultaneous().
  const zoomGesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-background">
        <View
          className="flex-row items-center justify-between border-b border-border bg-background px-4"
          style={{ paddingTop: insets.top, height: insets.top + 56 }}
        >
          <Pressable
            onPress={onClose}
            className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={`Close ${filename}`}
          >
            <X size={20} color={colors.foreground} />
          </Pressable>
          {onShare !== undefined ? (
            <Pressable
              onPress={onShare}
              disabled={sharing || uri === null}
              accessibilityState={{ disabled: uri === null, busy: sharing }}
              className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70 disabled:opacity-50"
              accessibilityRole="button"
              accessibilityLabel={`Share ${filename}`}
            >
              <Share size={20} color={colors.foreground} />
            </Pressable>
          ) : null}
        </View>
        {/* RNGH gestures need their own root inside an RN Modal — the app-root
            GestureHandlerRootView does not reach a Modal's native view hierarchy. */}
        <GestureHandlerRootView className="flex-1">
          <View className="flex-1 items-center justify-center overflow-hidden bg-black">
            {uri ? (
              <GestureDetector gesture={zoomGesture}>
                <Animated.View className="h-full w-full" style={imageStyle}>
                  <Image source={{ uri }} className="h-full w-full" contentFit="contain" />
                </Animated.View>
              </GestureDetector>
            ) : null}
          </View>
        </GestureHandlerRootView>
        {shareError ? (
          <View
            className="absolute inset-x-0 items-center px-6"
            style={{ bottom: insets.bottom + 16 }}
          >
            <View className="rounded-md bg-neutral-900/90 px-4 py-2 dark:bg-neutral-100/90">
              <Text className="text-center text-sm text-white dark:text-neutral-900">
                {shareError}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
