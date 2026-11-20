import { type SheetHeaderTopInset } from '@/lib/form-sheet';

/**
 * The sheet modes whose surface can present at the window top on iOS.
 *
 * Both name a `formSheet` route, and iOS sizes that sheet by its own maximum
 * height rather than by a fixed fraction of the window: on a phone whose window
 * is short enough, the maximum *is* the window, so the sheet presents at the
 * window top with its header inside the status bar. `never` promises the
 * opposite, `ios-page-sheet` presents below the status bar and pads its own
 * content, and `always` already reserves the inset itself.
 */
const PRESENTED_SHEET_MODES = {
  always: false,
  'bottom-form-sheet': true,
  'android-window-top': true,
  'ios-page-sheet': false,
  never: false,
} as const satisfies Record<SheetHeaderTopInset, boolean>;

/**
 * The band a sheet header adds because the platform presented its sheet above
 * the status bar, in points.
 *
 * The header's own reads cannot answer this: `measureInWindow`, the
 * transform-aware rect and the shadow tree's root metrics all resolve inside
 * the presented content, so they report the sheet's own origin whatever the
 * presentation did. `surfaceOriginTop` is therefore the native read of the
 * surface's origin in window coordinates (`presentedSurfaceOriginTop` in
 * `kilo-surface-geometry`), which is the one value that moves with the
 * presentation: 0 on a phone whose sheet reaches the window top, the
 * status-bar inset on one whose sheet presents below it.
 *
 * `insetTop` is the window's own top inset — the same value the status bar
 * occupies — so the difference is exactly the part of the band the sheet's
 * edge left uncovered. A sheet that presents at or below the inset uncovered
 * nothing and keeps `clearance`.
 */
export function presentedSheetTopClearance(input: {
  topInset: SheetHeaderTopInset | undefined;
  platform: string;
  /** `useSafeAreaInsets().top`: the window's own top inset. */
  insetTop: number;
  /** The surface's origin in window coordinates, or null where it is unread. */
  surfaceOriginTop: number | null;
  /** The clearance the header's surface mode already reserves, in points. */
  clearance: number;
}): number {
  const { topInset, platform, insetTop, surfaceOriginTop, clearance } = input;
  if (platform !== 'ios' || surfaceOriginTop === null) {
    return clearance;
  }
  if (topInset === undefined || !PRESENTED_SHEET_MODES[topInset]) {
    return clearance;
  }
  if (!Number.isFinite(insetTop) || insetTop <= 0 || !Number.isFinite(surfaceOriginTop)) {
    return clearance;
  }
  const uncovered = Math.min(insetTop, Math.max(0, insetTop - Math.max(0, surfaceOriginTop)));
  return Math.max(clearance, uncovered);
}
