/**
 * Wrap text that is interpolated into a translated sentence so it renders as
 * an inline run in its own direction: Unicode first-strong isolate (U+2068)
 * resolves the direction from the run's first strong character, and
 * pop-directional-isolate (U+2069) closes it. Without the pair, a device name
 * in a right-to-left script reorders the surrounding sentence and moves its
 * punctuation.
 */
export function isolateBidiText(text: string): string {
  return `\u2068${text}\u2069`;
}

/**
 * Wrap a run whose reading order is left-to-right whatever the paragraph
 * direction: Unicode left-to-right isolate (U+2066) pins the run's direction and
 * pop-directional-isolate (U+2069) closes it. Use it for a value a reader
 * compares position by position — a count pair like `1 / 5`, a range, a
 * version. First-strong (`isolateBidiText`) cannot: the run starts with digits,
 * which carry no direction, so it inherits the paragraph's and a right-to-left
 * screen mirrors `1 / 5` into `5 / 1`.
 */
export function isolateLtrBidiText(text: string): string {
  return `\u2066${text}\u2069`;
}
