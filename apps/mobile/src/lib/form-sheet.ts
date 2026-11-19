import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  StatusBar,
  useWindowDimensions,
  type ViewInstance,
} from 'react-native';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useScreenInsets } from '@/lib/screen-insets';

/**
 * The part of a React Native host element the settled read needs: the
 * transform-aware window rect, which includes the offset the platform's sheet
 * presentation gives the sheet's content.
 */
type MeasurableHostView = {
  getBoundingClientRect: () => { top: number };
};

/**
 * The native startup metrics, or null where the runtime does not expose them.
 *
 * Expo's root `SafeAreaProvider` starts from no metrics on native, so the
 * provider answers 0 for the first frames; the startup metrics are the same
 * `statusBars or displayCutout` union read from the window before React asked.
 * A partial `react-native-safe-area-context` mock omits the export and vitest
 * throws on the property access itself rather than answering undefined, so it
 * is read behind a guard (the same one the sheet shell uses for `BackHandler`).
 */
function readInitialWindowMetrics(): {
  insets: { top: number };
  frame: { height: number };
} | null {
  try {
    return initialWindowMetrics ?? null;
  } catch {
    return null;
  }
}

/**
 * The window's own top inset, known before the safe-area provider answers.
 *
 * The Android full detent reserves this inset. Resolved from the provider's
 * first, still-empty frame it fell back to `StatusBar.currentHeight`, which
 * stops at the status bar and leaves out the display cutout. The startup
 * metrics carry the full inset for the window the app started in, so they stand
 * in until the provider answers; a window that is no longer that one (rotated,
 * resized) keeps the status-bar fallback.
 */
function resolveWindowTopInset(top: number, windowHeight: number): number {
  if (top > 0) {
    return top;
  }
  const initial = readInitialWindowMetrics();
  if (initial && Math.abs(initial.frame.height - windowHeight) < 1) {
    return initial.insets.top;
  }
  return StatusBar.currentHeight ?? 0;
}

// Android formSheets can't hit 1.0 without clipping under the status bar, so
// the "full" detent is capped just below the top inset there; iOS can use 1.
export function useFormSheetDetents() {
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const androidTopInset = resolveWindowTopInset(top, height);
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
 *   there — the window inset would only be a dead band above the header. On
 *   Android `sheetShouldOverflowTopInset` (useFormSheetScreenOptions) lets the
 *   sheet surface reach the window top, and the detent cap
 *   (`useFormSheetDetents`) subtracts the window's own top inset from the full
 *   detent, so the surface settles at the status bar. The platform places the
 *   sheet's content itself and can settle it higher than the surface — the list
 *   settings sheet put its header 24 dp from the window top inside a 51.8 dp
 *   inset — so the header covers the rest once the sheet has settled
 *   (`useSettledSheetHeaderTopClearance`). A window with no
 *   top inset of its own leaves the sheet edge at the window top, where the
 *   header clears the status bar (and landscape cutout padding) itself.
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
 * window inset and the synchronous status-bar height — never from a layout
 * measurement: a frame measured at mount reports the surface before it is
 * presented, so reserving the inset from it and dropping it once the sheet
 * settles moves the whole header by the status-bar height. A surface the
 * platform places itself tops this up once it has settled.
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

/**
 * The clearance `sheetHeaderTopClearance` resolves for the current window.
 *
 * `topInset` is undefined for a header whose surface always owns the window (a
 * pinned screen header): the clearance is then zero, and neither the status-bar
 * height nor a platform check is read, so a plain header keeps working where the
 * runtime does not expose them.
 */
export function useSheetHeaderTopClearance(topInset: SheetHeaderTopInset | undefined): number {
  const screenInsets = useScreenInsets();
  const windowTopInset = useSafeAreaInsets().top;
  if (topInset === undefined) {
    return 0;
  }
  return sheetHeaderTopClearance({
    topInset,
    platform: Platform.OS,
    screenTopInset: screenInsets.top,
    windowTopInset,
    statusBarHeight: StatusBar.currentHeight ?? 0,
  });
}

/**
 * When the header samples where its surface sits, in ms after a movement.
 *
 * The platform moves a presented sheet without a React layout pass: it slides
 * the sheet in on presentation, and the list settings sheet expands from the
 * half detent to the full one when its Name field raises the keyboard, which
 * puts the header back inside the status bar well after the presentation. The
 * mount burst spans the presentation and every later burst spans the movement
 * that triggered it.
 */
const SHEET_PRESENT_SAMPLE_MS = [0, 120, 280, 500, 750];
const SHEET_MOVE_SAMPLE_MS = [0, 100, 200, 320, 450, 600, 800, 1000];

/** The keyboard emitter's shape; the module-level read below may find none. */
type KeyboardEmitter = {
  addListener: (
    event: 'keyboardDidShow' | 'keyboardDidHide',
    listener: () => void
  ) => { remove: () => void };
};

/**
 * The keyboard emitter, or null where the runtime does not expose it.
 *
 * A partial `react-native` mock omits the emitter and vitest throws on the
 * property access itself, so it is read behind a guard (the same one
 * `readInitialWindowMetrics` uses). Without it the presentation burst is the
 * only read, which is what the header had before the movement follow.
 */
function readKeyboardEmitter(): KeyboardEmitter | null {
  try {
    return (Keyboard as KeyboardEmitter | undefined) ?? null;
  } catch {
    return null;
  }
}

const KEYBOARD_EMITTER = readKeyboardEmitter();

/** What a sheet header reads from the surface it paints on. */
export type SettledSheetHeaderTopClearance = {
  /** The top clearance the header adds, in dp. */
  clearance: number;
  /** Re-reads the surface's edge; the header's own `onLayout`. */
  onLayout: () => void;
};

/**
 * The clearance a settled sheet header adds: the inset the surface's own edge
 * leaves uncovered, or the clearance its mode already reserves, whichever is
 * larger.
 *
 * `headerTop` is where the header's own top edge sits inside the window — the
 * header is the sheet's first row, so it inherits the edge the platform placed
 * the sheet's content at. A platform that presents the content at the window
 * top, or that stops at the status bar inside a taller display cutout, leaves
 * part of the inset above it; that difference is the band the header adds so
 * its rows clear the system bars.
 */
export function sheetHeaderSettledTopClearance(input: {
  clearance: number;
  insetTop: number;
  headerTop: number;
}): number {
  const intrusion = Math.min(input.insetTop, Math.max(0, input.insetTop - input.headerTop));
  return Math.max(input.clearance, intrusion);
}

/**
 * The clearance a sheet header adds once its surface has settled, in dp, plus
 * the layout callback that re-reads it.
 *
 * `sheetHeaderTopClearance` answers from the first frame and assumes the
 * platform settles the sheet below the inset. Android does not always: it
 * places the sheet's content itself, and the list settings sheet settled its
 * header 24 dp from the window top inside a 51.8 dp inset, which put the title
 * 13.7 dp inside the status bar. This reads where the header actually landed and
 * covers the rest, which also absorbs a sheet the platform presents at the
 * window top.
 *
 * A presented sheet moves again after it lands — the keyboard expands the list
 * settings sheet from the half detent to the full one and takes the header into
 * the status bar — so the read runs on the presentation, on every keyboard
 * change, and whenever the caller reports a new layout. The reserve only grows
 * within a mount, so a sample taken mid-movement never moves a settled header,
 * and a sample that finds the same edge keeps the state identity and costs no
 * render. iOS presents the sheet below the status bar itself, so it keeps the
 * platform's own clearance.
 */
export function useSettledSheetHeaderTopClearance(input: {
  topInset: SheetHeaderTopInset | undefined;
  /** The clearance the header's surface mode already reserves, in dp. */
  clearance: number;
  /** The header's own view, measured to find where the surface settled. */
  surfaceRef: RefObject<ViewInstance | null>;
}): SettledSheetHeaderTopClearance {
  const { topInset, clearance, surfaceRef } = input;
  const insetTop = useSafeAreaInsets().top;
  const [headerTop, setHeaderTop] = useState<number | null>(null);
  // The burst in flight: a newer one retires every sample of the older ones, so
  // a moving sheet is only ever measured by the burst that followed its move.
  const burstRef = useRef(0);
  const readable = topInset !== undefined && Platform.OS === 'android' && insetTop > 0;

  const sample = useCallback(() => {
    // `getBoundingClientRect` is the transform-aware read: React Native's
    // `measureInWindow` reports the sheet's layout slot, not the offset the
    // presentation gives it, and would answer the pre-settled position.
    const view = surfaceRef.current as MeasurableHostView | null;
    const measure = view?.getBoundingClientRect;
    if (measure === undefined) {
      return;
    }
    const { top } = measure.call(view);
    if (!Number.isFinite(top)) {
      return;
    }
    // Only a higher edge is news, and an unchanged value keeps the state
    // identity, so a sheet that did not move does not re-render.
    setHeaderTop(current => (current === null || top < current ? top : current));
  }, [surfaceRef]);

  const followMovement = useCallback(
    (delaysMs: readonly number[]) => {
      const burst = burstRef.current + 1;
      burstRef.current = burst;
      for (const delayMs of delaysMs) {
        setTimeout(() => {
          if (burstRef.current === burst) {
            sample();
          }
        }, delayMs);
      }
    },
    [sample]
  );

  useEffect(() => {
    if (readable) {
      followMovement(SHEET_PRESENT_SAMPLE_MS);
    }
    return () => {
      // Retires the samples still owed to this burst.
      burstRef.current += 1;
    };
  }, [followMovement, readable]);

  useEffect(() => {
    const listeners =
      readable && KEYBOARD_EMITTER !== null
        ? [
            KEYBOARD_EMITTER.addListener('keyboardDidShow', () => {
              followMovement(SHEET_MOVE_SAMPLE_MS);
            }),
            KEYBOARD_EMITTER.addListener('keyboardDidHide', () => {
              followMovement(SHEET_MOVE_SAMPLE_MS);
            }),
          ]
        : [];
    return () => {
      burstRef.current += 1;
      for (const listener of listeners) {
        listener.remove();
      }
    };
  }, [followMovement, readable]);

  const onLayout = useCallback(() => {
    if (readable) {
      followMovement(SHEET_MOVE_SAMPLE_MS);
    }
  }, [followMovement, readable]);

  return {
    clearance:
      headerTop === null
        ? clearance
        : sheetHeaderSettledTopClearance({ clearance, insetTop, headerTop }),
    onLayout,
  };
}
