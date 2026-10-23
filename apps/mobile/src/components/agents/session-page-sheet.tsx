import { type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateSurface } from '@/components/centered-state-surface';
import { Sheet } from '@/components/ui/sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** The one detent: the whole window. */
const SHEET_SNAP_POINTS = ['100%'];

type SessionPageSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Fires after the native dismiss animation completes. */
  onDismiss?: () => void;
  /**
   * Asked before Android Back closes the sheet, so a form with unsaved edits can
   * confirm first. Return false to keep the sheet open.
   */
  onRequestDismiss?: () => boolean;
  /**
   * Whether a downward drag closes the sheet. Read-only surfaces pass true so
   * the native dismiss gesture works. A sheet that edits its own values leaves
   * it off: the swipe is how a form loses its draft, and a drag that starts over
   * its scroll view used to close it when the user scrolled back up.
   */
  dismissible?: boolean;
  children: ReactNode;
};

/**
 * Shared full-window sheet for the session page. Callers render their own
 * SheetHeader, scroll content, and safe bottom spacer inside it. Android Back
 * and Done both route through `onClose`.
 *
 * The swipe and the iOS backdrop tap are off by default, because a full-window
 * sheet holds a form's whole scroll view and the native sheet claims every
 * downward drag that starts over it. A surface that shows data and holds no
 * edits passes `dismissible`, and then the drag is the same way out as Done.
 *
 * It is a native sheet at the full detent, so it stacks above the session
 * screen and above another native sheet. The sheet owns the whole window, so a
 * header inside it would reserve a dead band above the title if it read the
 * window top inset: iOS presents the sheet below the status bar already, while
 * Android expands it over the status bar and this surface pads the top inset
 * itself. Callers pass `topInset="ios-page-sheet"` to their SheetHeader to drop
 * that inset on both platforms.
 */
export function SessionPageSheet({
  visible,
  onClose,
  onDismiss,
  onRequestDismiss,
  dismissible = false,
  children,
}: Readonly<SessionPageSheetProps>) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  // Android expands the sheet over the status bar; iOS presents it below.
  const sheetTopInset = Platform.OS === 'ios' ? 0 : insets.top;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      onRequestDismiss={onRequestDismiss}
      dismissGestures={dismissible}
      snapPoints={SHEET_SNAP_POINTS}
      showHandle={false}
      background={colors.background}
    >
      <StateSurface
        style={{ paddingTop: sheetTopInset }}
        className="flex-1 bg-background"
        testID="session-page-sheet-surface"
      >
        {children}
      </StateSurface>
    </Sheet>
  );
}
