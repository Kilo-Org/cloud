import { type ReactNode } from 'react';
import { Modal, Platform, View } from 'react-native';
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
 * On Android the Modal fills the window, so the surface pads the top inset to
 * keep the content out of the system status bar. Android Back and Done both
 * route through `onClose`.
 */
export function SessionPageSheet({
  visible,
  onClose,
  onDismiss,
  children,
}: Readonly<SessionPageSheetProps>) {
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

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={{ paddingTop: insets.top }}
        className="flex-1 bg-background"
        testID="session-page-sheet-surface"
      >
        {children}
      </View>
    </Modal>
  );
}
