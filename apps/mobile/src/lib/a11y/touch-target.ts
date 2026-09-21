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

/** Width and height of a compact control's tap area, in pt. */
export function compactControlTargetDp(): number {
  return COMPACT_CONTROL_FRAME_DP + 2 * COMPACT_CONTROL_HIT_SLOP_DP;
}
