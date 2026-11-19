import { Portal } from '@rn-primitives/portal';
import { usePathname, useSegments } from 'expo-router';
import { useRef } from 'react';
import { View, type ViewInstance, type ViewStyle } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Toaster } from 'sonner-native';

import { useSheetHeaderBottom } from '@/components/sheet-toast-host';
import { CheckCircle2, Info, Loader, TriangleAlert, XCircle } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { shouldHideTabBar } from '@/lib/tab-bar-layout';
import { useRenderedTabBarHeight } from '@/lib/tab-bar-clearance';
import { getToastBottomOffset } from '@/lib/toast-offset';
import { useToastHost } from '@/lib/toast-host';

/**
 * sonner-native's container for bottom-center toasts is `position: absolute`
 * with no height, and every toast is one of its children positioned with
 * `bottom: 0`: each child sits entirely outside the container's bounds. Android
 * still paints it (the container does not clip), but
 * `View.isVisibleToUser()` intersects a child's rect with its parent's — an
 * empty intersection drops the whole toast from the accessibility tree. The
 * toast is then on screen and silent: TalkBack reads nothing, and a
 * `uiautomator dump` shows no toast at all, which is how the device harness
 * lost the "Link copied" confirmation.
 *
 * Anchoring the container to the top of its host gives every toast a rect
 * inside its parent without moving it — the toast still positions itself
 * against the container's `bottom` inset. `positionerStyle` is merged after
 * sonner's own container style and its safe-area insets, and `top` is the one
 * edge the container never sets for bottom-center toasts.
 */
const TOAST_POSITIONER_STYLE = { top: 0 } as const;

/**
 * The app's one toast appearance. The root Toaster sits at the bottom:
 * sonner-native's default top-center placement renders a toast over the
 * screen header, hiding the back control for the toast's whole lifetime (spot
 * check e4-end). Bottom is the transient-message convention: a toast may cover
 * the composer briefly, never the navigation. Inside a sheet the bottom holds
 * the sheet's actions instead, so there it sits under the header
 * (`SheetToaster`).
 */
function ThemedToaster({
  position,
  offset,
  positionerStyle,
  paddingVertical,
  fullWindowOverlay,
}: Readonly<{
  position: 'bottom-center' | 'top-center';
  offset: number;
  positionerStyle: ViewStyle;
  paddingVertical?: number;
  fullWindowOverlay: boolean;
}>) {
  const colors = useThemeColors();
  return (
    <Toaster
      position={position}
      offset={offset}
      fullWindowOverlay={fullWindowOverlay}
      positionerStyle={positionerStyle}
      icons={{
        success: <CheckCircle2 size={20} color={colors.good} />,
        error: <XCircle size={20} color={colors.destructive} />,
        warning: <TriangleAlert size={20} color={colors.warn} />,
        info: <Info size={20} color={colors.mutedForeground} />,
        loading: <Loader size={20} color={colors.mutedForeground} />,
      }}
      toastOptions={{
        style: {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          paddingVertical,
        },
        titleStyle: { color: colors.foreground },
        descriptionStyle: { color: colors.mutedForeground },
      }}
    />
  );
}

/**
 * The app's one Toaster. It renders in the app's main view tree unless an
 * Android native sheet is open: the sheet covers that tree there, so the
 * Toaster renders into the top sheet's toast host instead (`SheetToastScope`,
 * `@/lib/toast-host`), and a toast raised from the sheet is visible over it.
 * On iOS no sheet claims a host, and the root Toaster's window-level overlay
 * keeps it above every sheet. The toasts live in sonner-native's store, so the
 * ones on screen move with the Toaster.
 */
export function AppToaster() {
  const sheetHost = useToastHost();
  if (sheetHost === null) {
    return <RootToaster />;
  }
  return (
    <Portal name="app-toaster" hostName={sheetHost}>
      {/* Keyed: the host renders its portal entries as a list. */}
      <SheetToaster key="app-toaster" />
    </Portal>
  );
}

/**
 * The Toaster reads the keyboard from the `KeyboardProvider` above it, so its
 * height cannot drift from the one the screens reserve. It renders in a child
 * of `AppRootProviders`, so a keyboard show/hide re-renders only the Toaster,
 * never the app tree the provider wraps.
 *
 * Android needs this even though the app is edge-to-edge: under API 35+ the
 * window never resizes for the IME (`login-screen.tsx`), and
 * `react-native-safe-area-context` does not report IME insets, so a
 * bottom-anchored overlay has no other way to clear the keyboard and its
 * navigation row.
 *
 * The offset is one platform-free rule (`lib/toast-offset.ts`): iOS and Android
 * run the same math, and the platform enters only through the values resolved
 * here for it — the tab bar's own rendered height, which the bar's helper owns,
 * and the keyboard occlusion the shared hook already anchors to the screen
 * bottom.
 */
function RootToaster() {
  const { bottom } = useSafeAreaInsets();
  // The provider reports the whole strip the IME hides, anchored to the screen
  // bottom: on Android edge-to-edge its height is the full IME inset (the
  // navigation bar is translucent there, so nothing is subtracted), and on iOS
  // it is the keyboard's frame. A raw Android height that stopped at the
  // navigation bar left the toast's last line behind the IME's navigation row
  // (2026-09-20 review finding). `lib/toast-offset.ts` stays platform-free.
  const keyboardOcclusion = useKeyboardState(state => state.height);
  const segments = useSegments();
  const pathname = usePathname();
  // The floating tab bar is an absolute overlay over the screen bottom, so it
  // never appears in the reported bottom inset and a toast anchored to the
  // inset landed over the tab icons (2026-09-19 visual spot check, p1). It
  // renders exactly when the focused route sits inside the tabs navigator and
  // `shouldHideTabBar` does not hide it — the same predicate the bar's own
  // layout uses — so the toast clears it only while it is actually on screen;
  // a screen pushed over the tabs (agent-chat, pr-review) or the auth flow
  // keeps the toast at its resting offset. The bar publishes the height it
  // renders (it carries the bar's small Android-only extra padding and the
  // lines its labels reserve), so the toast cannot disagree with what is on
  // screen. See `lib/toast-offset.ts`.
  const renderedTabBarHeight = useRenderedTabBarHeight();
  const tabBarHeight =
    (segments as readonly string[]).includes('(tabs)') && !shouldHideTabBar(pathname, segments)
      ? (renderedTabBarHeight ?? 0)
      : 0;

  return (
    <ThemedToaster
      position="bottom-center"
      // Explicit offset, rather than sonner-native's `safe area inset + 8`:
      // the reported inset can under-report the bottom chrome (Android's IME
      // navigation row), which left the error toast's last line clipped under
      // it, and never covers the floating tab bar, which the toast then
      // covered. One platform-free rule; see `lib/toast-offset.ts`.
      offset={getToastBottomOffset({
        safeAreaBottom: bottom,
        keyboardHeight: keyboardOcclusion,
        tabBarHeight,
      })}
      positionerStyle={TOAST_POSITIONER_STYLE}
      // On iOS this lifts the Toaster into a window above every presented
      // sheet; Android has no such window and hosts it in the sheet instead.
      fullWindowOverlay
    />
  );
}

/** The gap between a sheet's header divider and the toast below it. */
const SHEET_TOAST_GAP = 4;

/**
 * Inside a sheet the container spans from the toast's top to the sheet's
 * bottom, so the top-anchored toast is inside its parent's rect (see
 * `TOAST_POSITIONER_STYLE`). `bottom` is the one edge sonner-native never sets
 * for top-center toasts. The container passes every touch outside the toast's
 * own box through to the sheet (sonner's `box-none`).
 */
const SHEET_TOAST_POSITIONER_STYLE = { bottom: 0 } as const;

/**
 * The in-sheet toast's vertical padding, down from sonner-native's 16. A short
 * sheet puts its actions right under its header: the "Discard changes?"
 * confirm's Discard button starts 49dp below the header divider (the body's
 * 10.5dp top pad, one 17.5dp line of message, the 21dp section gap). The
 * compact toast is 38dp tall (a 20dp line, 8dp above and below, the 1dp
 * border), so with the gap it ends 7dp above that button. Both lines grow
 * with the font scale (the message's by 17.5dp per unit of scale, the toast's
 * by 20dp), so at Android's largest scale, 200%, it still ends 4.5dp above.
 */
const SHEET_TOAST_PADDING_VERTICAL = 8;

/**
 * The Toaster inside a sheet's toast host (Android only, `SheetToastScope`).
 * It draws at the top of the sheet, right below the sheet's `SheetHeader`: a
 * bottom toast covered the bottom actions of a short sheet (the Discard button
 * of the "Discard changes?" confirm stopped taking taps on its centre), and the
 * header's own actions stay clear above it. A sheet with no `SheetHeader` gets
 * the toast at its top edge.
 *
 * The anchor fills the sheet's content frame and takes no touches itself.
 */
function SheetToaster() {
  const anchor = useRef<ViewInstance | null>(null);
  const { headerBottom, onAnchorLayout } = useSheetHeaderBottom(anchor);
  return (
    <View
      ref={anchor}
      onLayout={onAnchorLayout}
      collapsable={false}
      pointerEvents="box-none"
      className="absolute inset-0"
    >
      <ThemedToaster
        position="top-center"
        offset={(headerBottom ?? 0) + SHEET_TOAST_GAP}
        positionerStyle={SHEET_TOAST_POSITIONER_STYLE}
        paddingVertical={SHEET_TOAST_PADDING_VERTICAL}
        // The window-level overlay is iOS-only and draws in the app's main
        // window; the toast renders inline in the sheet's own views.
        fullWindowOverlay={false}
      />
    </View>
  );
}
