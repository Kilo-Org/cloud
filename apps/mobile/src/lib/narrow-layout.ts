/**
 * Window width (dp) below which the shell drops a fixed side-by-side row for a
 * stacked one.
 *
 * The design targets the narrowest common phone (320 dp), where a row's fixed
 * icon tile and trailing chevron still leave the flexible text column room for
 * a whole word. A window can be narrower than that: a split-screen pane, a
 * foldable's cover display, a large Android display-size override, or a test
 * device at 480x1000 @ 480 dpi (160 dp). There, the fixed siblings squeeze the
 * text column below one word's width and Android breaks that word mid-word
 * ("Gene ral", "CREDIT S", "PROFIL E") — the defect the launcher e1 round saw
 * on Profile and Preferences (2026-09-21).
 *
 * 240 dp leaves a full text column at every real phone width and switches to
 * the stacked presentation only where the row has genuinely run out of room.
 */
export const NARROW_LAYOUT_WIDTH = 240;

/**
 * Whether a window `width` dp wide is too narrow for a fixed side-by-side row.
 * An unknown width (a partial `useWindowDimensions` mock) keeps the standard
 * layout: the stacked presentation is the exception, never the default.
 */
export function isNarrowLayout(width: number | undefined): boolean {
  return width !== undefined && width < NARROW_LAYOUT_WIDTH;
}
