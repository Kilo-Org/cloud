/**
 * Whether a text or reasoning part needs the empty-string text repair.
 *
 * The generated part types declare `text: string` on text and reasoning parts,
 * but persisted storage and the wire can both omit the field, and a textless
 * part stored verbatim crashes every reader that does `part.text.trim()`. A
 * text or reasoning part whose `text` is absent or not a string needs the
 * repair; every other part — a non-text part, or a part that already carries
 * string text — needs none.
 *
 * The rule is declared once here so the persisted and wire normalizers fill the
 * same parts with `''`.
 */
export function needsPartTextRepair(part: { type?: unknown; text?: unknown }): boolean {
  if (part.type !== 'text' && part.type !== 'reasoning') return false;
  return typeof part.text !== 'string';
}
