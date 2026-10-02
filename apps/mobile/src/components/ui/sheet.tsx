import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { type ReactNode, useEffect, useState } from 'react';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The app's bottom sheet for a surface opened from a screen's local state.
 * This file is the only place that imports
 * `@expo/ui/community/bottom-sheet`. See the "Unified Elements" table in
 * `apps/mobile/AGENTS.md`.
 *
 * Use a route with `useFormSheetScreenOptions()` instead when the surface needs
 * a URL or its own screen — a route sheet is a real native sheet too.
 *
 * `SessionPageSheet` (`@/components/agents/session-page-sheet`) is the other,
 * distinct surface: the full-height page sheet the session page's 14 detail
 * sheets render inside. It keeps RN `Modal`, because it must present above the
 * session screen and the `topInset="ios-page-sheet"` contract is built on the
 * native pageSheet presentation.
 */

type SheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Fires after the native dismiss animation completes. */
  onDismiss?: () => void;
  /**
   * Detents, lowest first, as a percentage string (`'50%'`) or a pixel height.
   * Omit for a content-sized sheet. Android supports two states only and maps
   * them to the first and last entry.
   */
  snapPoints?: (string | number)[];
  /**
   * Show the native drag indicator. A sheet whose content owns the top of its
   * own window (a full-height reader with its own header bar) passes false.
   */
  showHandle?: boolean;
  children: ReactNode;
};

/**
 * Native bottom sheet, presented over the whole app. It presents a separate
 * native window, so it stacks above a `formSheet` route — unlike a JS sheet or
 * a `@rn-primitives/portal` overlay, which render inside the app's React tree
 * and disappear behind it.
 *
 * Android Back, a swipe down and a backdrop tap all dismiss. The native sheet
 * cannot separate those three, and every caller here dismisses on all of them.
 */
export function Sheet({
  visible,
  onClose,
  onDismiss,
  snapPoints,
  showHandle = true,
  children,
}: Readonly<SheetProps>) {
  const colors = useThemeColors();
  // Stay mounted through the dismiss animation. `index` -1 starts the animation
  // and the native dismiss event ends it, so unmounting here would cut the sheet
  // off mid-flight.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  if (!mounted) {
    return null;
  }

  return (
    <BottomSheet
      index={visible ? 0 : -1}
      snapPoints={snapPoints}
      // The native sheet paints the platform surface color: without this a
      // forced in-app dark theme still shows a light sheet behind themed text.
      backgroundStyle={{ backgroundColor: colors.card }}
      handleComponent={showHandle ? undefined : null}
      enablePanDownToClose
      onClose={onClose}
      onDismiss={() => {
        setMounted(false);
        onDismiss?.();
      }}
    >
      {children}
    </BottomSheet>
  );
}
