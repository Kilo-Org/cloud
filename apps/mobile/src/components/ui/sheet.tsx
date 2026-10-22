import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, View } from 'react-native';

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
  /**
   * Whether a downward drag on the sheet dismisses it (and, on iOS, a backdrop
   * tap). Defaults to true. A sheet whose content scrolls passes false: the
   * native sheet claims every downward drag that starts over a React Native
   * scroll view on iOS, so dragging the content back up would dismiss the sheet
   * and drop its values.
   */
  dismissGestures?: boolean;
  /**
   * Asked before a dismissal the sheet received by itself — Android Back or a
   * backdrop tap. Return false to keep the sheet open, which is how a form asks
   * its own "Keep editing / Discard" question first. iOS backdrop taps cannot
   * be separated from the drag, so `dismissGestures` governs those.
   */
  onRequestDismiss?: () => boolean;
  children: ReactNode;
};

/**
 * Native bottom sheet, presented over the whole app. It presents a separate
 * native window, so it stacks above a `formSheet` route and above another
 * native sheet — unlike a JS sheet or a `@rn-primitives/portal` overlay, which
 * render inside the app's React tree and disappear behind it.
 *
 * A content-sized sheet dismisses on a swipe down, a backdrop tap and Android
 * Back. A sheet whose content scrolls turns the swipe (and the iOS backdrop
 * tap) off with `dismissGestures={false}`, keeps Android Back, and answers it
 * through `onRequestDismiss`.
 */
export function Sheet({
  visible,
  onClose,
  onDismiss,
  snapPoints,
  showHandle = true,
  background,
  dismissGestures = true,
  onRequestDismiss,
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

  // Before the sheet's own window takes focus, Android Back reaches the app
  // instead of the sheet's native handler, so a press in that window of the
  // opening animation is answered here. Once the window has focus the sheet
  // receives Back natively and this listener does not run.
  const requestSelfDismissRef = useRef<() => void>(() => undefined);
  requestSelfDismissRef.current = () => {
    if (onRequestDismiss?.() === false) {
      return;
    }
    if (visible && dismissalPending) {
      return;
    }
    onClose();
  };
  useEffect(() => {
    if (Platform.OS !== 'android' || !mounted || !visible) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestSelfDismissRef.current();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [mounted, visible]);

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
      dismissGestures={dismissGestures}
      onRequestDismiss={onRequestDismiss}
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
      {Platform.OS === 'android' && !snapPoints?.length ? (
        // Material3 caps the sheet at 640dp; Expo UI sizes its content host to the window.
        <View className="w-full max-w-[640px] self-center">{children}</View>
      ) : (
        children
      )}
    </BottomSheet>
  );
}
