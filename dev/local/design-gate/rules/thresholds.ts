export const ROUNDING_DP = 0.5;
export const TOLERANCE_DP = 1;
export const ROW_MAX_HEIGHT_DP = 64;
export const ROW_CHILD_MAX_HEIGHT_DP = 48;
export const SINGLE_LINE_MAX_HEIGHT_DP = 30;
export const CONTROL_MAX_HEIGHT_DP = 64;
export const INK_DISTANCE = 48;
export const INK_MIN_ASYMMETRY_DP = 2;
export const INK_ASYMMETRY_RATIO = 0.12;
export const INK_MIN_COVERAGE = 0.02;
export const INK_MAX_COVERAGE = 0.85;
export const REST_SAMPLES = 2;
export const ANIMATED_SHIFT_MIN_MS = 200;
export const SHIFT_GROUP_VECTOR_DP = 0.5;
export const SHIFT_GROUP_MAX_RELATED = 10;
export const INSET_MIN_GAP_DP = 0.5;
export const INSET_MIN_ASYMMETRY_DP = 2;
export const INSET_ASYMMETRY_RATIO = 0.15;
export const INSET_MAX_HEIGHT_SHARE = 0.5;
export const INSET_MIN_WIDTH_SHARE = 0.6;
/**
 * Empty space allowed between a scrolling screen's top padding and its first
 * painted node: one section break. A first section header that keeps the same
 * air above its label as every later header (Home's, 23 dp) keeps the screen's
 * rhythm. More than that is a box that draws nothing (a control's touch frame,
 * usually) adding a hole under the header, as Profile's 31 dp did.
 */
export const LEADING_GAP_MAX_DP = 24;
/**
 * The page gutter: the start-side inset every screen's content begins at — the
 * header title, section labels, cards, row groups and a flat list row's content.
 * Tailwind's spacing step is 3.5 dp (a 14 dp rem over four steps), so the
 * contract's `px-4` lands exactly here.
 */
export const SCREEN_GUTTER_DP = 14;
/**
 * How far a measured start edge may sit from the gutter. Frames land within
 * half a dp of their layout value (a safe-area inset is fractional, 47.5 on a
 * landscape phone), and the nearest wrong inset is a half spacing step away —
 * 10.5 or 17.5 — so 0.75 accepts sub-pixel rounding without admitting an
 * off-grid inset such as 13 or 15.
 */
export const GUTTER_TOLERANCE_DP = 0.75;
