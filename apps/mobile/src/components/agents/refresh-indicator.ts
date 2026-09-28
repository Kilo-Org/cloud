import { type PlatformOSType } from 'react-native';

/**
 * Whether the platform's own pull-to-refresh indicator is inset in the scroll
 * content and cannot cover a row.
 *
 * Android's `SwipeRefreshLayout` floats its indicator over the top 24–64dp of
 * the scrollable that owns it — exactly the first row's pitch — and never moves
 * the content, so on a list whose first row starts at that edge the indicator
 * is not inset: it crosses the row's title and workspace subtitle for the whole
 * pull gesture and then rests on them while the app's reserved status band
 * already shows the in-flight spinner (device defect uxs1: the live Agents
 * list's spinner covered the first row's workspace subtitle). iOS insets its
 * content for the indicator, so there it cannot cover a row.
 *
 * The Agents rows lists therefore keep the platform indicator where it is inset
 * — iOS, where it *is* the surface's in-flight indicator — and park it off the
 * rows where it is not (`rowsRefreshIndicatorParkOffset`), letting the reserved
 * status band above the rows carry the in-flight state. Exactly one indicator
 * is visible per surface either way.
 */
export function nativeRefreshIndicatorIsInset(platform: PlatformOSType): boolean {
  return platform !== 'android';
}

/**
 * The `progressViewOffset` that parks the platform's pull indicator off the
 * rows list, or `undefined` to leave the platform default.
 *
 * Android's floating disc cannot be suppressed anywhere on the list: a
 * transparent colour is dropped as an unset prop (so the platform's opaque
 * default returns), and any in-view offset only moves the disc on top of what
 * the rows list sits between — over the first row (default), over the reserved
 * status band, or over the search field above it. Parking it below the fold
 * instead keeps the whole rows list clear, and the pull gesture itself is
 * untouched: the drag still reaches `onRefresh` and the reserved band's
 * spinner reports the refresh it starts (device defect uxs1).
 *
 * One viewport height is past the bottom of any list that fills a window; the
 * offset is in dp, like every other React Native layout value.
 */
export function rowsRefreshIndicatorParkOffset(
  platform: PlatformOSType,
  viewportHeightDp: number
): number | undefined {
  return nativeRefreshIndicatorIsInset(platform) ? undefined : viewportHeightDp;
}
