import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The app's sheet surface. This file is the only place that imports
 * `@expo/ui/community/bottom-sheet`. See the "Unified Elements" table in
 * `apps/mobile/AGENTS.md`.
 *
 * Use a route with `useFormSheetScreenOptions()` instead when the surface needs
 * a URL or its own screen — a route sheet is a real native sheet too.
 */

type SheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Fires after the native dismiss animation completes. */
  onDismiss?: () => void;
  /**
   * Detents, lowest first, as a percentage string (`'50%'`) or a pixel height.
   * Omit for a content-sized sheet. `['100%']` is the full-window surface.
   * Android supports two states only and maps them to the first and last entry.
   */
  snapPoints?: (string | number)[];
  /**
   * Show the native drag indicator. A sheet whose content owns the top of its
   * own window (a full-height surface with its own header bar) passes false.
   */
  showHandle?: boolean;
  /**
   * The sheet's own background. Defaults to the app's card surface. A
   * full-window surface that owns its whole window passes the colour it paints
   * so the sheet's edge never shows the card behind it.
   */
  background?: string;
  children: ReactNode;
};

/**
 * Native bottom sheet, presented over the whole app. It presents a separate
 * native window, so it stacks above a `formSheet` route and above another
 * native sheet — unlike a JS sheet or a `@rn-primitives/portal` overlay, which
 * render inside the app's React tree and disappear behind it.
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
  background,
  children,
}: Readonly<SheetProps>) {
  const colors = useThemeColors();
  // Stay mounted through the dismiss animation. `index` -1 starts the animation
  // and the native dismiss event ends it, so unmounting here would cut the sheet
  // off mid-flight.
  const [mounted, setMounted] = useState(visible);
  // A dismissal handed to the native sheet that has not reported back yet.
  const [dismissalPending, setDismissalPending] = useState(false);

  // The caller can reopen (`visible` true) while the dismiss animation is still
  // running, and the native dismissal then reports after the fact. Handing the
  // library `index` 0 at that moment races its own dismissal transition —
  // SwiftUI/UIKit drop the presentation and the sheet never comes back (observed
  // on device: host remounted, `presented` still false 15s later) — so the index
  // stays -1 until the dismissal reports. `onDismiss` then flips it to 0, the
  // transition the library's own note calls safe because the dismiss event only
  // fires once the transition finished.
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    // The host is up, so this hands the library its dismissal. Android reports
    // that dismissal from the host's own effect, which runs before this one;
    // `onDismiss` clears `mountedRef` in time for this check to see it.
    if (mountedRef.current) {
      setDismissalPending(true);
    }
  }, [visible]);

  if (!mounted) {
    return null;
  }

  return (
    <BottomSheet
      index={visible && !dismissalPending ? 0 : -1}
      snapPoints={snapPoints}
      // The native sheet paints the platform surface color: without this a
      // forced in-app dark theme still shows a light sheet behind themed text.
      backgroundStyle={{ backgroundColor: background ?? colors.card }}
      handleComponent={showHandle ? undefined : null}
      enablePanDownToClose
      onClose={() => {
        // A dismissal the caller already reopened past must not close the sheet
        // again through the caller's own handler. A self-dismissal (backdrop,
        // swipe, Android Back) has no pending request and reports while
        // `visible` is still true, so it is still forwarded.
        if (visible && dismissalPending) {
          return;
        }
        onClose();
      }}
      onDismiss={() => {
        setDismissalPending(false);
        if (visible && dismissalPending) {
          // Superseded: the caller reopened while this dismissal was in flight.
          // The next render hands the library `index` 0, re-presenting the sheet
          // the dismissal had taken down; the sheet stays mounted, so its content
          // never unmounts.
          return;
        }
        // Clear the host flag before queueing, not just with `setMounted`: on
        // Android this report runs from the host's effect, ahead of this
        // component's `[visible]` effect, which reads the flag to decide whether
        // a dismissal is still outstanding. Otherwise it re-arms
        // `dismissalPending` for a dismissal that already reported and the next
        // reopen passes -1 and never presents.
        mountedRef.current = false;
        setMounted(false);
        onDismiss?.();
      }}
    >
      {children}
    </BottomSheet>
  );
}
