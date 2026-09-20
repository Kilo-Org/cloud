// The one place the mobile tap-target geometry lives. Components import these
// numbers and classes instead of re-spelling them, so the audit floor, the
// design target and the box that carries them stay in step.

/**
 * The smallest box a control-size audit accepts on a control's own
 * accessibility node. The audit reads that node's view rect, so `hitSlop` does
 * not lift a smaller box above this floor (`DESIGN.md` touch-target rule).
 */
export const MIN_TAP_TARGET_DP = 28;

/**
 * The touch target `DESIGN.md:364` requires on touch surfaces, even when the
 * visual control is compact.
 */
export const TOUCH_TARGET_DP = 44;

/**
 * The box every icon-only control renders. Its own node carries the target, as
 * a control-size audit measures, and 32pt clears the audit's
 * {@link MIN_TAP_TARGET_DP} floor while fitting the agents header row's
 * existing `min-h-11` (`session-list-screen.tsx:160`) so no surrounding layout
 * moves. `DESIGN.md` keeps the compact control while the touch region below
 * grows to {@link TOUCH_TARGET_DP}.
 */
export const COMPACT_CONTROL_BOX_CLASS = 'h-[32px] w-[32px] items-center justify-center';

/**
 * Per-side `hitSlop` for {@link COMPACT_CONTROL_BOX_CLASS}, so the touch region
 * is 32 + 16 = 48pt. 48, not 44: Android lays a target out in whole physical
 * pixels, and a 44dp box at density 420 measured 43.81dp in the run behind
 * closed PR 6378, so the control-size audit's reach carries past
 * `DESIGN.md:364`'s 44pt rather than landing on it.
 */
export const COMPACT_CONTROL_HIT_SLOP_DP = 8;

/**
 * The box an inline text link renders. The sign-in legal links sit inside a
 * sentence, so their box is the control-size audit's {@link MIN_TAP_TARGET_DP}
 * floor and the slop carries the reach; a larger box would reflow the prose
 * that should keep `DESIGN.md`'s compact control look.
 */
export const INLINE_LINK_BOX_CLASS = 'min-h-[28px] min-w-[28px] items-center justify-center';

/**
 * Per-side `hitSlop` for {@link INLINE_LINK_BOX_CLASS}, lifting the
 * control-size audit's 28dp floor to `DESIGN.md:364`'s touch region:
 * 28 + 20 = 48pt.
 */
export const INLINE_LINK_HIT_SLOP_DP = 10;

/**
 * The reach a box plus its per-side slop offers. This is the number the tests
 * assert against {@link TOUCH_TARGET_DP} and the control-size audit floor.
 */
export function tapTargetReachDp(boxDp: number, slopDp: number): number {
  return boxDp + 2 * slopDp;
}
