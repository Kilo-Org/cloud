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
  children: ReactNode;
};

/**
 * Shared full-window sheet for the session page. Callers render their own
 * SheetHeader, scroll content, and safe bottom spacer inside it. Android Back
 * and Done both route through `onClose`.
 *
 * Pan-down dismissal is off: the surface hosts scrollable forms, and when the
 * scroll view sits at its top edge the native presentation claims an
 * upward-scroll drag and dismisses the sheet, discarding the edits (the
 * reported agents-form loss). There is no intended dismiss gesture on this
 * surface to lose — it presents at the whole window with no grabber and no
 * backdrop — so every close goes through the caller's own controls, and a form
 * can gate those with `useSheetDiscardGuard`. Android Back reaches the same
 * guard through its hardware-back listener.
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
      snapPoints={SHEET_SNAP_POINTS}
      showHandle={false}
      enablePanDownToClose={false}
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
