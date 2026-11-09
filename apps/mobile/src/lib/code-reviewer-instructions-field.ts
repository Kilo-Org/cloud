/**
 * Geometry of the custom-instructions editor field, mirroring the classes on
 * its `TextInput`: `p-3` is 10.5dp per side at the app's 14dp rem, and
 * `leading-[1.25rem]` is a 17.5dp line box. The field's cap, `max-h-[196px]`,
 * is that padding plus ten line boxes, so a caret scroll never paints the top
 * visible line cut.
 */
const INSTRUCTIONS_FIELD_VERTICAL_PADDING = 21;

/**
 * Whether a stored value is taller than the field's usable height, i.e. the
 * field will scroll and therefore open at the native caret (its end) with the
 * first line out of sight — the symptom #7892 removed only for values that fit
 * under the old growing field.
 *
 * `contentHeight` is the value's own height from `onContentSizeChange`, which
 * excludes the field's padding; `fieldHeight` is the field's laid-out height.
 * The half-point slack keeps a value that fits from being treated as
 * overflowing by measurement noise.
 */
export function instructionsFieldOverflows(contentHeight: number, fieldHeight: number): boolean {
  return contentHeight > fieldHeight - INSTRUCTIONS_FIELD_VERTICAL_PADDING + 0.5;
}
