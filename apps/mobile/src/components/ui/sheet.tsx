import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Platform, View } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { holdSheetTouch, SHEET_TOUCH_SETTLE_MS, useSheetTouchHold } from '@/lib/sheet-touch-guard';

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
   * Whether a downward drag on the sheet dismisses it, and, on iOS, a backdrop
   * tap too. Defaults to true. A sheet whose content scrolls passes false: the
   * native sheet claims every downward drag that starts over a React Native
   * scroll view on iOS, so dragging the content back up would dismiss the sheet
   * and drop its values, and a form keeps its backdrop for the same reason. On
   * Android the backdrop is the scrim, which `enablePanDownToClose` governs
   * beside Android Back, and this wrapper always keeps that on.
   */
  dismissGestures?: boolean;
  /**
   * Asked before a dismissal the sheet received by itself — Android Back, the
   * Android scrim, or an iOS backdrop tap. Return false to keep the sheet open,
   * which is how a form asks its own "Keep editing / Discard" question first.
   * An iOS backdrop tap can only be reported after it happened, so the caller
   * refusing one is what keeps the sheet open.
   */
  onRequestDismiss?: () => boolean;
  /**
   * Whether the content clears the status bar itself, so the sheet does not
   * reserve that inset for it. On Android the sheet is a dialog window, and the
   * window reports its insets only after the sheet was measured: the sheet then
   * first spans the whole window and shrinks by the status bar once that report
   * arrives, moving everything it holds down by that height after it appeared.
   * A full-window surface that pads its own top inset passes true from values
   * it knows before the first frame, and its first painted frame is the settled
   * one. iOS presents its sheet below the status bar and ignores this.
   */
  contentOwnsTopInset?: boolean;
  children: ReactNode;
};

/**
 * Native bottom sheet, presented over the whole app. It presents a separate
 * native window, so it stacks above a `formSheet` route and above another
 * native sheet — unlike a JS sheet or a `@rn-primitives/portal` overlay, which
 * render inside the app's React tree and disappear behind it.
 *
 * Dismissal follows what the sheet holds, not how tall it is. A sheet that
 * shows data (a message, a run, a detail) keeps the swipe, the backdrop tap and
 * Android Back, so the drag is one more way out beside Done. A sheet that holds
 * a draft — a form, a filter, a composer — turns the swipe and the iOS backdrop
 * tap off with `dismissGestures={false}`, keeps Android Back and the Android
 * scrim, and answers it through `onRequestDismiss`: either gesture would
 * otherwise throw the draft away while the user was still working on it.
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
  contentOwnsTopInset = false,
  children,
}: Readonly<SheetProps>) {
  const colors = useThemeColors();
  // The native sheet paints a few strings of its own — the backdrop's dismiss
  // label, the drag handle and the sheet's pane title. They resolve against the
  // device locale unless it is told the app's, so a device in Portuguese
  // announced Portuguese controls inside an Arabic app.
  const { i18n } = useTranslation();
  // Stay mounted through the dismiss animation. `index` -1 starts the animation
  // and the native dismiss event ends it, so unmounting here would cut the sheet
  // off mid-flight.
  const [mounted, setMounted] = useState(visible);
  // The app-wide touch gate stays shut in the two windows where this sheet's
  // own window does not take touch: while it opens, and while it dismisses.
  // During the dismissal the native sheet has already let go of touch but has
  // not reported the finished animation, so the tap a double press aimed at the
  // sheet's Apply would otherwise reach the screen behind it.
  const [selfDismissalStarted, setSelfDismissalStarted] = useState(false);
  // A dismissal the caller asked for: `visible` is false while the sheet is
  // still mounted waiting for the native report.
  const dismissing = (!visible && mounted) || selfDismissalStarted;
  useSheetTouchHold({ opening: visible, dismissing });
  // The settle hold's release from the latest report; a ref keeps `onDismiss`
  // free of state and `holdSheetTouch` off the render path. Re-arming on the
  // next report replaces the previous one, so two reports never double-arm.
  const settleReleaseRef = useRef<(() => void) | null>(null);
  // The bound covers the report that never comes; unmount drops what is left,
  // so a removed sheet cannot outlive its own window's settle.
  useEffect(
    () => () => {
      settleReleaseRef.current?.();
      settleReleaseRef.current = null;
    },
    []
  );

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
  // A dismissal handed to the native sheet that has not reported back yet.
  const [dismissalPending, setDismissalPending] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // A caller turning the sheet back on re-presents it, so its earlier
      // dismissal was superseded: the next self-dismissal reports again.
      forwardedSelfDismissRef.current = false;
      return;
    }
    // The host is up, so this hands the library its dismissal. Android reports
    // that dismissal from the host's own effect, which runs before this one;
    // `onDismiss` clears `mountedRef` in time for this check to see it.
    if (mountedRef.current) {
      setDismissalPending(true);
    }
  }, [visible]);

  // A dismissal the sheet starts itself — a downward drag, the backdrop or
  // Android Back — is granted here and reported later, so the settle window is
  // armed while the caller still has `visible` true. A refused request keeps
  // the sheet up and must not arm the gate.
  const selfDismissRef = useRef<() => boolean>(() => true);
  selfDismissRef.current = (): boolean => {
    if (onRequestDismiss?.() === false) {
      return false;
    }
    setSelfDismissalStarted(true);
    return true;
  };
  // Before the sheet's own window takes focus, Android Back reaches the app
  // instead of the sheet's native handler, so a press in that window of the
  // opening animation is answered here. Once the window has focus the sheet
  // receives Back natively and this listener does not run.
  // Still set when the previous self-dismiss call already handed the caller the
  // close and that close has not been superseded: the dismissal the caller then
  // starts forwards to the library's `onClose` as soon as `visible` is false,
  // which must not reach the caller a second time. Cleared by the caller
  // reopening while the dismissal is in flight, so a re-presented sheet asks
  // fresh instead of swallowing its next self-dismissal.
  const forwardedSelfDismissRef = useRef(false);
  const requestSelfDismissRef = useRef<() => void>(() => undefined);
  requestSelfDismissRef.current = () => {
    // A dismissal the caller superseded is already on its way out; asking again
    // would raise the caller's own confirm a second time for one press.
    if (visible && dismissalPending) {
      return;
    }
    if (onRequestDismiss?.() === false) {
      return;
    }
    forwardedSelfDismissRef.current = true;
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
      contentOwnsTopInset={contentOwnsTopInset}
      // The iOS sheet draws the dimmed backdrop through its presentation, so the
      // app's view tree cannot see that tap: the library reports it and this
      // wrapper answers it the way Android Back is answered, `onRequestDismiss`
      // included. The library only reports while `dismissGestures` is on, which
      // keeps a draft-holding sheet's backdrop inert.
      onBackdropTap={() => {
        requestSelfDismissRef.current();
      }}
      onRequestDismiss={() => selfDismissRef.current()}
      locale={i18n.language}
      onClose={() => {
        // A dismissal the caller already reopened past must not close the sheet
        // again through the caller's own handler. A self-dismissal (backdrop,
        // swipe, Android Back) has no pending request and reports while
        // `visible` is still true, so it is still forwarded.
        if (visible && dismissalPending) {
          return;
        }
        // A reported self-dismissal that already handed the caller the close
        // must not arrive a second time once the caller dropped `visible` and
        // the native dismissal reports through this prop.
        if (forwardedSelfDismissRef.current) {
          forwardedSelfDismissRef.current = false;
          return;
        }
        onClose();
      }}
      onDismiss={() => {
        // Whatever started the dismissal, the finished report ends the close
        // request lease. It also arms the settle hold directly here: the host
        // tears the sheet's window down in the frames around this report,
        // measured on the emulator (the window went before the report reached
        // this tree, and a touch between the two opened the row behind it), so
        // the lease ending together with the window's teardown leaves exactly
        // the frames no window shields unprotected. Holding here instead of in
        // the hook keeps the settle off the reopen path: the report the caller
        // superseded answers a dismissal that is over, so the fresh window has
        // its own opening window.
        settleReleaseRef.current?.();
        settleReleaseRef.current = holdSheetTouch(SHEET_TOUCH_SETTLE_MS);
        setSelfDismissalStarted(false);
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
