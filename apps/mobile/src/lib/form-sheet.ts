import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useScreenInsets } from '@/lib/screen-insets';

// Android formSheets can't hit 1.0 without clipping under the status bar, so
// the "full" detent is capped just below the top inset there; iOS can use 1.
export function useFormSheetDetents() {
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const androidTopInset = top > 0 ? top : (StatusBar.currentHeight ?? 0);
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

  return { fullSheetDetent };
}

/**
 * The options every formSheet route in the app registers.
 *
 * `sheetShouldOverflowTopInset` makes Android measure `sheetAllowedDetents`
 * against the full stack height, the way iOS does, and stops the sheet being
 * lifted by the bottom system gesture inset. Without it Android subtracts the
 * top inset a second time at the bottom — the sheet surface ends above the
 * window bottom and the screen behind it shows through the strip under the
 * sheet (the new-session screen's olive "Start session" button under the repo
 * picker). `fullSheetDetent` keeps the top edge below the status bar in that
 * full-height measure.
 */
export function useFormSheetScreenOptions() {
  const { fullSheetDetent } = useFormSheetDetents();
  const colors = useThemeColors();

  return {
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, fullSheetDetent] as [number, number],
    sheetGrabberVisible: true,
    headerShown: false,
    sheetShouldOverflowTopInset: true,
    // iOS lifts this background out of `contentStyle` and paints the presented
    // sheet view with it. Without it the sheet surface is transparent, so the
    // dimmed screen shows through as a grey card until the route paints.
    contentStyle: { backgroundColor: colors.background },
  };
}

/**
 * Who owns the top of the window for a sheet header, i.e. whether the header
 * has to clear the status bar itself:
 *
 * - 'always': the surface owns the top of the window (full-screen modals), so
 *   the status-bar inset applies whenever it is non-zero.
 * - 'bottom-form-sheet': a bottom-anchored formSheet. On iOS the native sheet
 *   presents below the status bar, so the header reserves no top clearance
 *   there — the window inset would only be a dead band above the header.
 *   On Android `sheetShouldOverflowTopInset` (useFormSheetScreenOptions)
 *   lets the sheet surface reach the top of the window, and the detent cap
 *   (`useFormSheetDetents`) subtracts the window's own top inset from the
 *   full detent, so a window that reports one always settles the sheet edge
 *   at the status bar and the header reserves nothing. Only a window with no
 *   top inset of its own leaves the sheet edge at the window top, where the
 *   header must clear the status bar (and landscape cutout padding) itself.
 * - 'android-window-top': the same Android surface reaches the window top and
 *   the sheet does not settle below the status bar, so the header clears it
 *   itself — measured on the PR review formSheets, whose header sits at the
 *   window top with its own status-bar padding. iOS presents the native sheet
 *   below the status bar, so there the header reserves nothing.
 * - 'ios-page-sheet': the SessionPageSheet surface owns the top of the window
 *   on both platforms, so the header reserves no top clearance — the native
 *   iOS pageSheet presents below the status bar, and the Android full-window
 *   Modal pads its own top inset (session-page-sheet). `useSafeAreaInsets`
 *   still reports the window's inset inside either Modal, so reading it in the
 *   header would leave a dead band above the title.
 * - 'never': the surface can never reach the window top (half-detent-only
 *   sheets), so the header reserves no top clearance on either platform —
 *   the inset would only be a dead band above the title.
 */
export type SheetHeaderTopInset =
  | 'always'
  | 'bottom-form-sheet'
  | 'android-window-top'
  | 'ios-page-sheet'
  | 'never';

/**
 * The top clearance a sheet header reserves, in dp.
 *
 * Decided from values that are known before the surface's first frame — the
 * window inset the app boots with and the synchronous status-bar height —
 * never from a layout measurement: a frame measured at mount reports the
 * surface before it is presented, so reserving the inset from it and dropping
 * it once the sheet settles moves the whole header by the status-bar height.
 * Both sheet headers read this one rule so they cannot disagree.
 */
export function sheetHeaderTopClearance(input: {
  topInset: SheetHeaderTopInset;
  platform: string;
  /** `useScreenInsets().top`: the window inset plus the landscape corner pad. */
  screenTopInset: number;
  /** `useSafeAreaInsets().top`: the window's own top inset. */
  windowTopInset: number;
  /** `StatusBar.currentHeight`, or 0 where the platform has none. */
  statusBarHeight: number;
}): number {
  const { topInset, platform, screenTopInset, windowTopInset, statusBarHeight } = input;
  const resolvedTopInset = screenTopInset > 0 ? screenTopInset : statusBarHeight;
  // The inset the detent cap subtracts (`useFormSheetDetents`), from the same
  // two inputs: the header and the cap must never disagree, or the header
  // reserves clearance the sheet edge already provides.
  const detentTopInset = windowTopInset > 0 ? windowTopInset : statusBarHeight;
  // The one question every mode answers: does the surface reach the window top
  // on this platform, so the header has to clear the status bar itself?
  const surfaceOwnsWindowTop =
    topInset === 'always' ||
    (topInset === 'android-window-top' && platform === 'android') ||
    (topInset === 'bottom-form-sheet' && platform === 'android' && detentTopInset === 0);
  return surfaceOwnsWindowTop ? resolvedTopInset : 0;
}

/** The clearance `sheetHeaderTopClearance` resolves for the current window. */
export function useSheetHeaderTopClearance(topInset: SheetHeaderTopInset): number {
  const screenInsets = useScreenInsets();
  const windowTopInset = useSafeAreaInsets().top;
  return sheetHeaderTopClearance({
    topInset,
    platform: Platform.OS,
    screenTopInset: screenInsets.top,
    windowTopInset,
    statusBarHeight: StatusBar.currentHeight ?? 0,
  });
}
