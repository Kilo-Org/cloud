/**
 * The layout contract's shared classes (`apps/mobile/AGENTS.md`, "Layout
 * contract"). Every screen, header, sheet, list row, section header and empty
 * state sits at the same page gutter, and a scrolling body keeps one section
 * gap and one top pad, so a screen cannot drift from the others.
 *
 * The strings stay literal: NativeWind compiles the classes it finds at build
 * time, so an interpolated or composed value would not exist on device.
 */

/** The one horizontal page inset: 14pt. */
export const SCREEN_GUTTER_CLASS = 'px-4';

/**
 * The same 14pt inset as a number, for the one place that has to know a
 * body's width before its container has laid out: `px-4` at the app's 14pt
 * rem. A block that picks a layout from its own measured width reads this
 * for its first frame instead of guessing.
 */
export const SCREEN_GUTTER_DP = 14;

/**
 * The contract's 21pt break between the blocks of one screen body. A body whose
 * content is a single wrapper puts this on the wrapper: the body class spaces
 * its own children, and the wrapper is the only one there.
 */
export const SCREEN_SECTION_GAP_CLASS = 'gap-6';

/** A scrolling screen body: 21pt between sections, 14pt gutter, 10.5pt top pad. */
export const SCREEN_BODY_CLASS = 'gap-6 px-4 pt-3';

/**
 * The top offset a nested section keeps inside a tighter group: the contract's
 * 21pt section gap (`SCREEN_SECTION_GAP_CLASS`) less the 7pt the group's
 * `gap-2` already lands above the child. Measured on the new-session form, the
 * branch block then starts 21.4pt under the repository field, the same break
 * the Run on and Repository sections keep.
 */
export const NESTED_SECTION_GAP_CLASS = 'mt-4';

/**
 * The separation a compact `top` state keeps from the control above it in a
 * list: the search field's own `my-3` lands its 10.5pt under the field, and this
 * constant lands the second 10.5pt, so the pair is the contract's 21pt section
 * gap (`SCREEN_SECTION_GAP_CLASS`) instead of the 10.5pt a state with no spacing
 * of its own leaves. A state that has a section header below it adds its own
 * bottom gap on top of this one; a state that is the last thing in its scroller
 * adds nothing, because the scroller already pads the end.
 */
export const CONTROL_TO_STATE_GAP_CLASS = 'mt-3';
