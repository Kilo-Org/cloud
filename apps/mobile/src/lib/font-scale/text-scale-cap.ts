/**
 * The cap a text node hands React Native so its native measurement re-runs
 * when the system font scale changes.
 *
 * React Native converts a text `fontSize` from sp to pixels once, while it
 * parses that node's props, and keeps the result until the node updates again.
 * The activity handles a font-size change in place (`android:configChanges`
 * includes `fontScale`), so no node re-parses on its own and on-screen text
 * would keep the old glyph size. A `maxFontSizeMultiplier` that tracks the
 * live scale is a prop change on every text node, and RN's own conversion is
 * `min(scaledValue, value * density * maxFontScaleMultiplier)`:
 *
 * - sans caller cap, the cap equals the current scale, which is exactly the
 *   size RN would have produced anyway (`min` never engages);
 * - with a caller cap, the two bound each other the way RN bounds them today;
 * - a scale below 1 cannot be expressed as a multiplier (RN requires NaN, 0 or
 *   >= 1 and ignores anything else), and 0 means "no cap", so RN's own
 *   conversion applies the smaller scale unchanged.
 *
 * `undefined` means "leave the node alone": it has no live scale to track.
 */
export function resolveFontScaleCap(
  fontScale: number | null,
  callerMaxFontSizeMultiplier?: number
): number | undefined {
  if (fontScale === null || !Number.isFinite(fontScale) || fontScale <= 0) {
    return undefined;
  }
  // RN logs a warning and ignores a multiplier in (0, 1); 0 and NaN mean no cap.
  const callerCap =
    callerMaxFontSizeMultiplier != null &&
    Number.isFinite(callerMaxFontSizeMultiplier) &&
    callerMaxFontSizeMultiplier >= 1
      ? callerMaxFontSizeMultiplier
      : Number.POSITIVE_INFINITY;
  const effective = Math.min(fontScale, callerCap);
  return effective < 1 ? 0 : effective;
}
