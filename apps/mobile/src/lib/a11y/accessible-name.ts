/**
 * Joins the facts of a composed accessible name.
 *
 * A composed accessible name is one sequence of facts — a name, its caption,
 * its state — never a list of offered items, so punctuation separates the
 * parts. `Intl.ListFormat` has no punctuation list: `type: 'conjunction'`
 * inserts a word in French, German, Arabic and Hindi, and `type: 'unit'` still
 * inserts one in French, German and Arabic. A comma separates in every catalog
 * language, and joining in logical order leaves the display direction to the
 * platform's bidi pass.
 *
 * Absent parts are dropped so a caller may pass a name, a caption and a state
 * that are each optional, in the order the screen presents them.
 */
export function joinAccessibleName(parts: readonly (string | null | undefined)[]): string {
  const present: string[] = [];
  for (const part of parts) {
    if (part != null && part !== '') {
      present.push(part);
    }
  }
  return present.join(', ');
}
