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
 *
 * The `-my-[7px]` is the layout-neutral form. The box's 28dp floor is twice
 * the `text-xs` line it sits in (line-height `calc(1 / 0.75)` of 10.5dp = 14dp),
 * so without it the box lifts the whole sentence row to 28dp and centres the
 * glyphs in a taller line. Cancelling `(28 - 14) / 2` on each side leaves the
 * node's own rect at the audit floor while the row keeps a plain text line and
 * one baseline. When the surrounding text is larger than `text-xs`, its line
 * wins over the shorter box outer, so the cancel is safe for either size.
 */
export const INLINE_LINK_BOX_CLASS =
  'min-h-[28px] min-w-[28px] -my-[7px] items-center justify-center';

/**
 * Per-side horizontal `hitSlop` for {@link INLINE_LINK_BOX_CLASS}, lifting the
 * control-size audit's 28dp floor to `DESIGN.md:364`'s touch region across the
 * sentence: 28 + 20 = 48pt.
 */
export const INLINE_LINK_HIT_SLOP_DP = 10;

/**
 * Per-side vertical `hitSlop` for {@link INLINE_LINK_BOX_CLASS}. `DESIGN.md:364`
 * asks for the touch region in both axes, so the vertical slop is 8:
 * 28 + 2 * 8 = 44pt. It is the minimum that meets the target: unlike the
 * horizontal reach, which spends the sentence's own width, every extra dp of
 * vertical region has to be reserved as free space around the row
 * ({@link INLINE_LINK_ROW_CLASS}). The box's layout-neutral `-my-[7px]` form
 * keeps the sentence on its `text-xs` line while the box's 28dp rect overflows
 * that line by `(28 - 14) / 2 = 7dp` on each side, so each link's vertical
 * region reaches `7 + 8 = 15dp` beyond the line — exactly the free space
 * {@link INLINE_LINK_ROW_CLASS} reserves for it.
 */
export const INLINE_LINK_VERTICAL_HIT_SLOP_DP = 8;

/**
 * The `hitSlop` both legal links render: at least `DESIGN.md:364`'s 44pt touch
 * region in both axes (48pt horizontally, 44pt vertically).
 */
export const INLINE_LINK_HIT_SLOP = {
  top: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
  bottom: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
  left: INLINE_LINK_HIT_SLOP_DP,
  right: INLINE_LINK_HIT_SLOP_DP,
} as const;

/**
 * The extra vertical margin the legal sentence row carries, and its class.
 *
 * A legal link's 44pt vertical region reaches
 * `(28 - 14) / 2 + 8 = 15dp` past the `text-xs` line it sits on. The screen's
 * `gap-3` gutter to the Continue button above the row (and to the ghost button
 * below it) is 10.5dp — 4.5dp short — so a region at the full 44pt would reach
 * into the Continue button's frame, and a tap on its bottom strip would open
 * Terms instead of sending the code (an earlier revision capped the region at
 * 3dp to avoid that and lost the target). The row therefore adds 5dp:
 * 10.5 + 5 = 15.5dp of free space each side, which holds the whole 44pt region
 * clear of both neighbours. The row itself still lays out on a `text-xs` line;
 * the margin is the extra gutter the target needs, and it is part of the row's
 * box, not its height.
 */
export const INLINE_LINK_ROW_MARGIN_DP = 5;
export const INLINE_LINK_ROW_CLASS = 'my-[5px]';

/**
 * The class an inline-link connector carries so the two links' facing slops do
 * not overlap. The connector node is the only thing between them, so it has to
 * be at least `2 * {@link INLINE_LINK_HIT_SLOP_DP}` = 20dp wide; a narrower
 * node (ru `" и "`, pl `" i "`, ar `" و "`, zh `" 和 "`) would let the second
 * link's left slop reach into the first's right slop, and a tap between them
 * would be claimed by the later sibling. English `" and "` is already wider, so
 * its spacing is unchanged; `text-center` keeps the shorter connectors centred
 * on the space they reserve.
 */
export const INLINE_LINK_CONNECTOR_CLASS = 'min-w-[20px] text-center';

/**
 * The reach a box plus its per-side slop offers. This is the number the tests
 * assert against {@link TOUCH_TARGET_DP} and the control-size audit floor.
 */
export function tapTargetReachDp(boxDp: number, slopDp: number): number {
  return boxDp + 2 * slopDp;
}
