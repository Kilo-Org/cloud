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
 * The contract's 21pt break between the blocks of one screen body. A body whose
 * content is a single wrapper puts this on the wrapper: the body class spaces
 * its own children, and the wrapper is the only one there.
 */
export const SCREEN_SECTION_GAP_CLASS = 'gap-6';

/** A scrolling screen body: 21pt between sections, 14pt gutter, 10.5pt top pad. */
export const SCREEN_BODY_CLASS = 'gap-6 px-4 pt-3';

/**
 * The top offset of a section that starts inside another section's group and
 * carries the break itself. The form puts its sibling sections 17.5pt below the
 * field before them, and a nested block's own offset is what lands: the group's
 * `gap-2` does not add above it. This offset therefore holds the whole
 * 17.5pt break, so a nested section reads at the same rhythm as a top-level one.
 */
export const NESTED_SECTION_GAP_CLASS = 'mt-5';
