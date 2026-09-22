/**
 * Geometry for the app's compact icon controls: icon-only controls whose glyph
 * or circle stays small while the tap area still meets the 44pt minimum
 * (DESIGN.md). A control-size audit measures the *frame* a control renders, not
 * its glyph, so a Pressable sized to its icon reports the icon's size; the
 * frame has to carry the target itself.
 *
 * NativeWind's rem is 14pt here, so a frame spelled `h-11` measures 38.5pt on
 * device: above the 28dp floor an accessibility audit accepts, and 3pt of hit
 * slop per side carries it to 44pt. Frames stay literal class strings in the
 * components (NativeWind reads them at build time); these numbers keep the
 * arithmetic and its checks in one place. `comment-trailing-controls.ts` holds
 * the one control whose neighbour bounds its tap area.
 */

/** The smallest frame a control-size audit accepts, in dp. */
export const MIN_AUDITED_CONTROL_FRAME_DP = 28;

/** `h-11` measured on device: 2.75rem at NativeWind's 14pt rem. */
export const COMPACT_CONTROL_FRAME_DP = 38.5;

/** Hit slop per side that lifts the compact frame to the 44pt minimum. */
export const COMPACT_CONTROL_HIT_SLOP_DP = 3;

/**
 * Hit slop per side of the composer's `lg` voice toggle, in dp, unchanged from
 * the value the toggle already shipped with. `lg` is `h-10 w-10`, i.e. 35dp at
 * NativeWind's 14pt rem, so the slop is what widens its tap area past the
 * 28dp audited frame floor. The composer input row keeps the toggle's
 * neighbours one `COMPOSER_CONTROL_GAP_DP` away, which has to exceed this slop
 * plus the row's own or the two tap areas overlap
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

/** Width and height of a compact control's tap area, in pt. */
export function compactControlTargetDp(): number {
  return COMPACT_CONTROL_FRAME_DP + 2 * COMPACT_CONTROL_HIT_SLOP_DP;
}
