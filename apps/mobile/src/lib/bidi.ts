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
