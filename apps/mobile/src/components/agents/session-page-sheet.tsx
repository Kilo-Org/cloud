import { type ReactNode } from 'react';
import { Modal, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type SessionPageSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Fires on iOS after the native pageSheet dismiss animation completes. */
  onDismiss?: () => void;
  children: ReactNode;
};

/**
 * Shared sheet surface for the session page. On iOS it renders the native
 * pageSheet Modal and keeps the current safe-area behavior; callers render
 * their own SheetHeader, scroll content, and safe bottom spacer inside it.
 * On Android it renders a transparent full-window Modal with a dimmed blocking
 * scrim and a bottom-aligned half-height surface, so the session stays visible
 * behind it. Scrim press, Android Back, and Done all route through `onClose`.
 */
export function SessionPageSheet({
  visible,
  onClose,
  onDismiss,
  children,
}: Readonly<SessionPageSheetProps>) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
        onDismiss={onDismiss}
      >
        <View className="flex-1 bg-background">{children}</View>
      </Modal>
    );
  }

  const usableHeight = windowHeight - insets.top - insets.bottom;
  const surfaceHeight = Math.floor(usableHeight * 0.5);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityLabel="Close sheet"
          testID="session-page-sheet-scrim"
        />
        <View
          style={{ height: surfaceHeight }}
          className="overflow-hidden rounded-t-3xl bg-background"
          testID="session-page-sheet-surface"
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}
