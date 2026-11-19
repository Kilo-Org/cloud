import { Portal } from '@rn-primitives/portal';
import { usePathname, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Toaster } from 'sonner-native';

import { StateSurface, useStateSurface } from '@/components/centered-state-surface';
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
 * The app's one toast appearance. bottom-center: sonner-native's default
 * top-center placement renders a toast over the screen header, hiding the back
 * control for the toast's whole lifetime (spot check e4-end). Bottom is the
 * transient-message convention: a toast may cover the composer briefly, never
 * the navigation.
 */
function ThemedToaster({
  offset,
  fullWindowOverlay,
}: Readonly<{ offset: number; fullWindowOverlay: boolean }>) {
  const colors = useThemeColors();
  return (
    <Toaster
      position="bottom-center"
      offset={offset}
      fullWindowOverlay={fullWindowOverlay}
      positionerStyle={TOAST_POSITIONER_STYLE}
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
        },
        titleStyle: { color: colors.foreground },
        descriptionStyle: { color: colors.mutedForeground },
      }}
    />
  );
}

/**
 * The app's one Toaster. While no native sheet is open it renders in the
 * app's main view tree. A native sheet covers that tree on both platforms, so
 * while one is open the Toaster renders into the top sheet's toast host
 * instead (`SheetToastScope`, `@/lib/toast-host`), and a toast raised from the
 * sheet is visible over it. The toasts live in sonner-native's store, so the
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
      fullWindowOverlay
    />
  );
}

/**
 * The Toaster inside a sheet's toast host. The toasts anchor to the
 * sheet's content frame, and that frame can reach past what is on screen:
 * Android lays a formSheet route out at its largest detent and hands an
 * imperative sheet with snap points the window height, and the software
 * keyboard covers the bottom of a sheet the platform does not lift. So the
 * Toaster sits in a measured surface over the frame and clears the part of it
 * that is not visible.
 */
function SheetToaster() {
  return (
    <StateSurface pointerEvents="box-none" className="absolute inset-0">
      <SheetToasterContent />
    </StateSurface>
  );
}

function SheetToasterContent() {
  const surface = useStateSurface();
  const register = surface?.register;
  // The native geometry observer runs only while a reader is registered.
  useEffect(() => register?.(), [register]);
  // `frame` is the visible part of the sheet's content frame, after the
  // window, the sheet's clip and the keyboard; `bounds` is the whole frame.
  const hiddenBelow =
    surface?.frame && surface.bounds
      ? Math.max(0, surface.bounds.bottom - surface.frame.bottom)
      : 0;
  return (
    <ThemedToaster
      offset={
        hiddenBelow +
        getToastBottomOffset({ safeAreaBottom: surface?.safeAreaBottom ?? 0, keyboardHeight: 0 })
      }
      // A window-level overlay draws in the app's main window, and on-device
      // testing found it behind the presented sheet (2026-07-07, iOS): the
      // toast renders inline in the sheet's own views instead.
      fullWindowOverlay={false}
    />
  );
}
