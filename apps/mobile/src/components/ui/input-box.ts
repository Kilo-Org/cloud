/**
 * The single-line box's own geometry, kept in its own module because both the
 * native `Input` and a preview box that stands in for a resting single-line
 * field need the same two strings. They live beside `Input` rather than inside
 * it so a box that only paints a value does not have to import the native
 * component — and so a test that stubs `@/components/ui/input` still measures
 * the real box.
 */

/**
 * The single-line box's shape: the 44pt floor and the 10.5pt physical
 * horizontal inset, without the caller's chrome or text size.
 */
export const INPUT_BOX_SHAPE_CLASS = 'min-h-[44px] pl-3 pr-3';

/**
 * The single-line box's line height, applied after the caller's classes so a
 * `text-sm` line height cannot win over it on the real field or on a preview.
 */
export const INPUT_BOX_LINE_HEIGHT_CLASS = 'leading-[normal]';
