import { I18nManager, Platform } from 'react-native';

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
 * Android's minimum touch-target size (`<Button>` 48dp rule, the size the
 * control-size audit reports from the node's own view rect). `hitSlop` widens
 * the touch region but not the rect, so an icon-only control meets this only
 * with a real 48dp box.
 */
export const ICON_TARGET_DP = 48;

/**
 * The box an interactive icon-only control renders: its own node carries the
 * whole {@link ICON_TARGET_DP} target. Explicit px, because NativeWind's rem
 * is 14pt here — `h-11` measures 38.5pt on device, under Android's 48dp
 * minimum. Icon glyphs inside stay at their designed size; the box only
 * centres them on the larger target.
 */
export const ICON_TARGET_BOX_CLASS = 'h-[48px] w-[48px] items-center justify-center';

/**
 * The minimum an action's own node renders inside a state surface — an empty
 * or error state's way out. Android's `<Button>` rule is 48dp, and a
 * control-size audit reads the pressed node's view rect, so the shared
 * `Button` default frame (`min-h-[44px]`) lands 4dp under it; `hitSlop` widens
 * the touch region without moving that rect. 48 clears iOS's 44pt on the same
 * node, so one class serves both platforms and no `Platform` branch is needed.
 * Explicit px, because NativeWind's rem is 14pt here.
 */
export const STATE_ACTION_TARGET_DP = 48;

/** The floor every state surface's action renders, as {@link STATE_ACTION_TARGET_DP}. */
export const STATE_ACTION_CLASS = 'min-h-[48px]';

/**
 * The frame an interactive row or segment renders on its own pressable node —
 * a selection row, a menu row, a disclosure row, a picker row. A row sized by
 * its content reports that content's height, and `hitSlop` widens the touch
 * region without moving the rect a control-size audit reads, so the floor has
 * to be the row's class. The same floor clears Android's button minimum and the
 * design target on iOS, so one class serves both platforms and no `Platform`
 * branch is needed. Explicit px, because NativeWind's rem shrinks the
 * `min-h-11` scale step below both.
 */
export const ROW_TARGET_CLASS = 'min-h-[48px]';

/**
 * The box a profile row's identity block renders: the item's name and what
 * qualifies it, declared first in the row. It spans {@link ICON_TARGET_DP}, the
 * height of the controls beside it, so its frame is the row's leading top
 * corner rather than a shorter block the taller control boxes start above.
 * Assistive technology focuses a row from its layout, so a block that starts
 * higher is reached before those controls. Explicit px, because NativeWind's
 * rem is 14pt here.
 */
export const ROW_IDENTITY_CLASS = 'min-h-[48px] min-w-0 flex-1 justify-center';

/**
 * The frame a dense interactive row renders when it keeps the group's own
 * rhythm instead of {@link ROW_TARGET_CLASS}: `py-3` top and bottom plus the
 * row's 13px value line. Measured on the Android emulator at font scale 1, a
 * `KvRow` reads 38.9–39.6 dp tall — the rhythm every `KvRow` group already
 * uses. A list of counts reads as one column, so its rows keep that rhythm
 * rather than the taller interactive frame.
 */
export const DENSE_ROW_FRAME_DP = 39;

/**
 * Per-side vertical `hitSlop` of a row on {@link DENSE_ROW_FRAME_DP}:
 * `39 + 3 + 3 = 45 dp`, past `DESIGN.md:364`'s 44pt design target, so even the
 * shortest measured frame (38.9 dp) reaches 44.9 dp. Stacked rows share the
 * boundary between them, so two neighbours' reaches meet instead of leaving a
 * dead strip, and neither reaches another control.
 */
export const DENSE_ROW_HIT_SLOP_DP = 3;

/** The `hitSlop` a row on {@link DENSE_ROW_FRAME_DP} renders, as {@link DENSE_ROW_HIT_SLOP_DP}. */
export const DENSE_ROW_HIT_SLOP = {
  top: DENSE_ROW_HIT_SLOP_DP,
  bottom: DENSE_ROW_HIT_SLOP_DP,
} as const;

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
 * The box a text-only action renders so its own node carries the platform's
 * minimum touch target: `DESIGN.md:364`'s 44pt on iOS and
 * {@link ICON_TARGET_DP}'s 48dp on Android. The agents history link is one such
 * action: its label is a single eyebrow line, so without a box of its own the
 * node's rect is that line (measured 14.7pt on device) and a control-size audit
 * reads exactly that rect — `hitSlop` widens the touch region, not the rect.
 *
 * Both axes are minimums because a caller drops its hit slop: a short label
 * (`common.done` in Arabic or Japanese, `chat.messageActions.edit`) is only a
 * couple of glyphs wide, so a height floor alone would leave the rect under
 * {@link MIN_TAP_TARGET_DP} horizontally. The label centres in the wider box
 * (`items-center justify-center`), the same form as the voice-test field's
 * compact text control, so a long label is untouched.
 *
 * Explicit px, because NativeWind's rem is 14pt here: `min-h-11` renders
 * 38.5pt, under both minimums. They are minimums, not fixed sizes, so a label
 * scaled by large Dynamic Type still grows the frame. Read at render time
 * rather than captured in a module constant, so it follows the platform (the
 * trap `attachment-preview-strip.tsx` documents); the utilities stay spelled
 * out because NativeWind extracts them from the source text.
 */
export function textActionTargetClass(): string {
  return Platform.OS === 'android' ? 'min-h-[48px] min-w-[48px]' : 'min-h-[44px] min-w-[44px]';
}

/**
 * The box an inline text link renders. The sign-in legal links sit inside a
 * sentence, so their box is the control-size audit's {@link MIN_TAP_TARGET_DP}
 * floor and the slop carries the reach; a larger box would reflow the prose
 * that should keep `DESIGN.md`'s compact control look.
 *
 * The `-my-[7px]` is the layout-neutral form. It cancels the box's 28dp floor
 * down to a 14dp outer, so the box can never lift the sentence row to its own
 * height and centre the glyphs in a taller line; the node's own rect stays at
 * the audit floor while the row keeps one text line and one baseline. The
 * sentence itself is `text-sm` ({@link INLINE_LINK_SENTENCE_LINE_DP} 17.5dp), so
 * the text line is taller than the box's outer and sets the row height, exactly
 * as it did while the copy was `text-xs`.
 *
 * The box therefore overflows its own flex line by
 * `(28 - {@link INLINE_LINK_SENTENCE_LINE_DP}) / 2` on each side, and a row that
 * wraps needs {@link INLINE_LINK_LINE_GAP_CLASS} between its lines: wrapped
 * lines have no gutter of their own, and without it the box on a line reaches
 * into the prose of the line above it.
 */
export const INLINE_LINK_BOX_CLASS =
  'min-h-[28px] min-w-[28px] -my-[7px] items-center justify-center';

/**
 * The line a sentence carrying {@link INLINE_LINK_BOX_CLASS} lays out on, in dp:
 * `text-sm` at NativeWind's 14dp rem, whose `1.25rem` line-height is 1.4× the
 * 12.25dp type (`DESIGN.md`'s label step). Everything below measures the box's
 * overflow against this line rather than assuming the old `text-xs` one.
 */
export const INLINE_LINK_SENTENCE_LINE_DP = 17.5;

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
 * keeps the sentence on its `text-sm` line
 * ({@link INLINE_LINK_SENTENCE_LINE_DP}) while the box's 28dp rect overflows it
 * by `(28 - 17.5) / 2 = 5.25dp` on each side, so each link's vertical region
 * reaches `5.25 + 8 = 13.25dp` beyond the line — inside the free space
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
 * The vertical gap a wrapping sentence row keeps between its lines, and its
 * class. A sentence with an inline link row wraps in long locales, and a link
 * box's layout-neutral form makes its rect overflow its own flex line by
 * `(28 - {@link INLINE_LINK_SENTENCE_LINE_DP}) / 2 = 5.25dp` on each side.
 * Without a gap the wrapped lines sit one text line apart, so a box on the
 * second line reaches up into the first line's prose (and a box on the first
 * line reaches down into the second). The gap is the next whole dp above that
 * overflow plus its headroom, so a wrapped line never collides with the box on
 * the line before it while the two lines still read as one sentence; a sentence
 * that fits one line never sees it, because a flex row's `gap-y` only separates
 * wrapped lines.
 */
export const INLINE_LINK_LINE_GAP_DP = 7;
export const INLINE_LINK_LINE_GAP_CLASS = 'gap-y-[7px]';

/**
 * The extra vertical margin the legal sentence row carries, and its class.
 *
 * A legal link's 44pt vertical region reaches
 * `(28 - {@link INLINE_LINK_SENTENCE_LINE_DP}) / 2 + 8 = 13.25dp` past the text
 * line it sits on. The screen's `gap-3` gutter to the Continue button above the
 * row (and to the ghost button below it) is 10.5dp — 2.75dp short — so a region
 * at the full 44pt would reach into the Continue button's frame, and a tap on
 * its bottom strip would open Terms instead of sending the code (an earlier
 * revision capped the region at 3dp to avoid that and lost the target). The row
 * therefore adds 5dp: 10.5 + 5 = 15.5dp of free space each side, which holds
 * the whole 44pt region clear of both neighbours. The row itself still lays out
 * on one text line; the margin is the extra gutter the target needs, and it is
 * part of the row's box, not its height. The wrapped-line gap
 * ({@link INLINE_LINK_LINE_GAP_CLASS}) is separate from it: this margin is
 * outside the row, that gap is between the row's own lines.
 */
export const INLINE_LINK_ROW_MARGIN_DP = 5;
export const INLINE_LINK_ROW_CLASS = 'my-[5px] gap-y-[7px]';

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
 * The box a legal link renders — the two store links under the credit packs —
 * rather than a word inside a sentence with a neighbour
 * {@link INLINE_LINK_BOX_CLASS} has to stay clear of. A link that ends a
 * sentence uses {@link INLINE_LINK_BOX_CLASS} instead: it sits in the prose, so
 * it takes the audit floor and the slop rather than a standalone box.
 *
 * The whole target is the box, {@link ICON_TARGET_DP} 48dp tall and wide, the
 * size the control-size audit reads from a node's own rect (Android's
 * `<Button>` minimum). `hitSlop` cannot reach it: the audit measures the rect,
 * not the touch region.
 *
 * The utilities below are spelled out rather than interpolated from the dp
 * constants beside them: the class compiler reads class names out of the source
 * files, so an interpolated name can miss the generated stylesheet and silently
 * apply nothing. The tests hold the literals to the constants.
 */
export const LEGAL_LINK_MIN_DP = 48;

/**
 * The box two store legal links render in a wrapping row. Both keep their full
 * {@link LEGAL_LINK_MIN_DP} height in the flow, so the row's lines are 48dp
 * tall: when a long locale wraps the second link onto its own line the two
 * boxes sit one gutter apart and can never overlap, so a tap between the lines
 * opens the link it points at. The footer pays one 48dp line for that, which is
 * what keeps the geometry honest: a box that cancelled its own height would
 * reach 17dp into the line below. The links' copy is `text-xs`, a 14dp line.
 */
export const LEGAL_LINK_BOX_CLASS = 'min-h-[48px] min-w-[48px] items-center justify-center';

/**
 * The row the two store legal links share: side by side when they fit, one per
 * line when a long locale wraps them. `gap-x-4` separates two boxes on one line
 * (14dp, and no slop points sideways); the boxes' own height separates the
 * wrapped lines.
 */
export const LEGAL_LINK_ROW_CLASS = 'flex-row flex-wrap items-center gap-x-4';

/**
 * The reach a box plus its per-side slop offers. This is the number the tests
 * assert against {@link TOUCH_TARGET_DP} and the control-size audit floor.
 */
export function tapTargetReachDp(boxDp: number, slopDp: number): number {
  return boxDp + 2 * slopDp;
}

/**
 * Hit slop per side of the composer's `lg` voice toggle, in dp, unchanged from
 * the value the toggle already shipped with. `lg` is `h-10 w-10`, i.e. 35dp at
 * NativeWind's 14pt rem, so the slop is what widens its tap area past the
 * {@link MIN_TAP_TARGET_DP} audited frame floor. The composer input row keeps
 * the toggle's leading neighbour one `COMPOSER_CONTROL_GAP_DP` away, which has
 * to exceed this slop plus the row's own or the two tap areas overlap
 * (`chat-composer-input-row.tsx`).
 */
export const VOICE_INPUT_LG_HIT_SLOP_DP = 4;

/**
 * Hit slop per side the agent composer's input row gives the controls it owns
 * (the newline control and the send/stop control), in dp: the value the row
 * already shipped with. Their frames are already 44pt (iOS) / 48dp (Android),
 * so the slop only has to stay inside `COMPOSER_CONTROL_GAP_DP`.
 */
export const COMPOSER_CONTROL_HIT_SLOP_DP = 6;

/**
 * Leading gap between adjacent controls in the agent composer's input row, in
 * dp: the `ms-3` class is 0.75rem at NativeWind's 14pt rem, the same width as
 * the row's own `px-3` gutter. It has to carry the two facing hit slops, or the
 * neighbours' tap areas overlap and a tap between them cannot be told apart
 * (spot check e1 / e1-en-two-msg: with no gap at all the microphone and the
 * send/stop circles merged into one shape).
 */
export const COMPOSER_CONTROL_GAP_DP = 10.5;

/**
 * Clearance between the tap areas of two adjacent composer input-row controls,
 * in dp: the row's gap less the voice toggle's slop and the row's own slop. A
 * positive value means the two tap areas never overlap.
 */
export function composerControlClearanceDp(): number {
  return COMPOSER_CONTROL_GAP_DP - VOICE_INPUT_LG_HIT_SLOP_DP - COMPOSER_CONTROL_HIT_SLOP_DP;
}

/**
 * Leading gap of the send/stop control when the voice toggle sits before it:
 * `ms-1` is 3.5dp (0.25rem at NativeWind's 14pt rem). The gap is narrower than
 * the facing slops, so both controls zero the side that faces the other
 * ({@link composerFacingHitSlop}). It stays above zero because the idle toggle
 * (`bg-secondary`) and the empty-input send (`bg-muted`) share one colour:
 * flush, the two circles read as one shape.
 */
export const COMPOSER_VOICE_SEND_GAP_CLASS = 'ms-1';

/**
 * Per-side `hitSlop` with the side that faces the closer neighbour set to 0, so
 * the voice toggle and the send/stop control keep separate tap areas across
 * {@link COMPOSER_VOICE_SEND_GAP_CLASS}. `facing` is logical and `hitSlop` is
 * physical: the row mirrors in RTL, so the `end` side is the left edge there.
 */
export function composerFacingHitSlop(slopDp: number, facing: 'start' | 'end') {
  const facesRight = facing === 'end' ? !I18nManager.isRTL : I18nManager.isRTL;
  return {
    top: slopDp,
    bottom: slopDp,
    left: facesRight ? slopDp : 0,
    right: facesRight ? 0 : slopDp,
  };
}
