/**
 * The surface a read-only value sits on inside a tool part sheet: a rounded,
 * filled box with its own inset, so the value has padding on both sides.
 *
 * Android draws its default focus highlight over the whole rect of the focused
 * view. A selectable `Text` is focusable — `TextView.setTextIsSelectable` calls
 * `setFocusableInTouchMode(true)` and `setFocusable(FOCUSABLE_AUTO)` — and the
 * part sheet gives the first of those nodes focus when it opens, so the value
 * would otherwise paint a sharp-cornered band flush to its text (`ScreenHeader`
 * clips the same platform layer on its back control). Here the band lands
 * inside a designed field instead, the way the bash command row and the
 * read-only setup field already present their value.
 */
export const TOOL_VALUE_SURFACE_CLASS = 'rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900';
