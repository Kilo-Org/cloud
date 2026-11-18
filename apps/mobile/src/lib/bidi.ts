/**
 * Unicode left-to-right isolate (U+2066) and its pop-directional-isolate close
 * (U+2069). Written as separate marks for a run built from several inline
 * `Text` elements: render the open mark as a string child before the first
 * element and the close mark after the last. A style alone does not hold such a
 * run — each element keeps its own run, which takes the paragraph's direction.
 */
export const LTR_ISOLATE_OPEN = '\u2066';
export const LTR_ISOLATE_CLOSE = '\u2069';

/**
 * Wrap text that is interpolated into a translated sentence so it renders as
 * an inline run in its own direction: Unicode first-strong isolate (U+2068)
 * resolves the direction from the run's first strong character, and
 * pop-directional-isolate (U+2069) closes it. Without the pair, a device name
 * in a right-to-left script reorders the surrounding sentence and moves its
 * punctuation.
 */
export function isolateBidiText(text: string): string {
  return `\u2068${text}${LTR_ISOLATE_CLOSE}`;
}

/**
 * Wrap a run whose reading order is left-to-right whatever the paragraph
 * direction: `LTR_ISOLATE_OPEN` pins the run's direction and the close mark
 * pops it. Use it for a value a reader compares position by position — a count
 * pair like `1 / 5`, a range, a version, a path. First-strong (`isolateBidiText`)
 * cannot: the run starts with digits or a neutral, which carry no direction, so
 * it inherits the paragraph's and a right-to-left screen mirrors `1 / 5` into
 * `5 / 1`.
 */
export function isolateLtrBidiText(text: string): string {
  return `${LTR_ISOLATE_OPEN}${text}${LTR_ISOLATE_CLOSE}`;
}
