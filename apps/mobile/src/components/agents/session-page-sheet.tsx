import { type ReactNode, useEffect, useState } from 'react';
import { AppState, Modal, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateSurface } from '@/components/centered-state-surface';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { subscribePrivacyCover } from '@/lib/privacy-cover-events';

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
  const [coverClosed, setCoverClosed] = useState(false);

  // Close when the privacy cover fires (app backgrounds on a covered route).
  // The caller `onClose` can be a stacked closer that only pops an inner view
  // and leaves `visible` true, so tear the native Modal down here too instead
  // of trusting the caller to do it.
  useEffect(
    () =>
      subscribePrivacyCover(() => {
        setCoverClosed(true);
        onClose();
      }),
    [onClose]
  );

  // Release the forced close on the next foreground, so a caller that kept
  // `visible` true is not left holding a sheet that can never show again.
  useEffect(() => {
    if (!coverClosed) {
      return undefined;
    }
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setCoverClosed(false);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [coverClosed]);

  const open = visible && !coverClosed;

  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={open}
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
      visible={open}
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
