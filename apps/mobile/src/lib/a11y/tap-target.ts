import { I18nManager } from 'react-native';

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
 * The frame a compact `h-11` control renders, in pt. NativeWind's rem is 14pt
 * here, so `h-11` (2.75rem) measures 38.5pt on device: above the
 * {@link MIN_TAP_TARGET_DP} floor a control-size audit accepts, and
 * {@link COMPACT_H11_HIT_SLOP_DP} per side carries it to
 * {@link TOUCH_TARGET_DP}. This is the second compact geometry beside
 * {@link COMPACT_CONTROL_BOX_CLASS}: an `h-11` frame is set by its
 * surroundings' layout (`discussion-thread.tsx`, `comment-row.tsx`), not by the
 * icon-button box that 32pt defines. The frames stay literal class strings in
 * the components (NativeWind reads them at build time); these numbers keep the
 * arithmetic and its checks in one place. `comment-trailing-controls.ts` holds
 * the one control whose neighbour bounds its tap area.
 */
export const COMPACT_H11_FRAME_DP = 38.5;

/**
 * Per-side `hitSlop` that lifts {@link COMPACT_H11_FRAME_DP} to
 * `DESIGN.md:364`'s 44pt minimum: 38.5 + 3 + 3 = 44.5pt.
 */
export const COMPACT_H11_HIT_SLOP_DP = 3;

/** Width and height of an `h-11` compact control's tap area, in pt. */
export function compactControlTargetDp(): number {
  return tapTargetReachDp(COMPACT_H11_FRAME_DP, COMPACT_H11_HIT_SLOP_DP);
}

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
 * Per-side horizontal `hitSlop` of an inline link pointing at its neighbour.
 * The two legal links are separated only by the sentence's connector, and the
 * connector's own floor ({@link INLINE_LINK_CONNECTOR_CLASS}) is the only thing
 * keeping the two facing reaches apart, so this side is deliberately short: the
 * link still reaches `DESIGN.md:364`'s 44pt from its {@link MIN_TAP_TARGET_DP}
 * floor as `28 + facing + outer`, while only `facing` of that reach points at
 * the neighbour, so the visible gap between the words stays the sentence's own
 * spacing instead of the reserved box's.
 */
export const INLINE_LINK_FACING_HIT_SLOP_DP = 4;

/**
 * Per-side horizontal `hitSlop` of an inline link pointing away from its
 * neighbour, over plain prose with no other control to reach:
 * `28 + 4 + 12 = 44pt`.
 */
export const INLINE_LINK_OUTER_HIT_SLOP_DP = 12;

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
 * The per-side `hitSlop` of the legal link that sits at the given end of the
 * sentence. `hitSlop` is physical while the sentence's ends are logical, so the
 * start/end resolve to left/right through the interface direction: a flex-row
 * mirrors in RTL, so the link at the sentence's start faces the connector on its
 * other physical side. Both links keep the same vertical slop
 * ({@link INLINE_LINK_VERTICAL_HIT_SLOP_DP}); only the horizontal sides differ,
 * facing = {@link INLINE_LINK_FACING_HIT_SLOP_DP} and outer =
 * {@link INLINE_LINK_OUTER_HIT_SLOP_DP}.
 */
export function inlineLinkHitSlop(edge: 'start' | 'end') {
  const facesRight = edge === 'start' ? !I18nManager.isRTL : I18nManager.isRTL;
  return {
    top: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
    bottom: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
    left: facesRight ? INLINE_LINK_OUTER_HIT_SLOP_DP : INLINE_LINK_FACING_HIT_SLOP_DP,
    right: facesRight ? INLINE_LINK_FACING_HIT_SLOP_DP : INLINE_LINK_OUTER_HIT_SLOP_DP,
  };
}

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
 * The class an inline-link connector carries so the two links' facing reaches do
 * not overlap. The connector node is the only thing between them, so its floor
 * is `2 * {@link INLINE_LINK_FACING_HIT_SLOP_DP}` = 8dp plus 2dp of headroom, so
 * the two 4dp facing reaches never meet: 10dp. The old 20dp floor was the
 * symmetric `2 * 10dp` slop, which centred a short conjunction (ru `" и "`,
 * pl `" i "`, ar `" و "`, zh `" 和 "`) in 20dp and added ~4.5dp of gap on each
 * side of the `i` on top of the sentence's own space. English `" and "` is
 * already wider, so its spacing is unchanged; `text-center` keeps the shorter
 * connectors centred on the space they reserve.
 */
export const INLINE_LINK_CONNECTOR_CLASS = 'min-w-[10px] text-center';

/**
 * The reach a box plus its per-side slop offers. This is the number the tests
 * assert against {@link TOUCH_TARGET_DP} and the control-size audit floor.
 */
export function tapTargetReachDp(boxDp: number, slopDp: number): number {
  return boxDp + 2 * slopDp;
}
