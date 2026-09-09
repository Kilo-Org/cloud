import { type ReactNode } from 'react';
import { Modal, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateSurface } from '@/components/centered-state-surface';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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
  const colors = useThemeColors();

  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={visible}
        // RN Modal paints its container white. Android unmounts the children
        // before the slide-out ends, so the container shows as a white flash.
        backdropColor={colors.background}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
        onDismiss={onDismiss}
      >
        <StateSurface className="flex-1 bg-background" testID="session-page-sheet-surface">
          {children}
        </StateSurface>
      </Modal>
    );
  }

  return (
    <Modal
      visible={visible}
      backdropColor={colors.background}
      animationType="slide"
      onRequestClose={onClose}
    >
      <StateSurface
        style={{ paddingTop: insets.top }}
        className="flex-1 bg-background"
        testID="session-page-sheet-surface"
      >
        {children}
      </StateSurface>
    </Modal>
  );
}
