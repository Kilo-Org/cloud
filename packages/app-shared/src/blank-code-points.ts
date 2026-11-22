/**
 * The one answer to "does this code point draw nothing of its own?".
 *
 * The filler code points are letters or symbols by category and still draw a
 * blank: the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, and the braille
 * blank U+2800. They are the shapes a blank value is usually padded with.
 *
 * An unpaired surrogate counts as blank too. It is half a code point, has no
 * glyph, and printed text spells it `\uNNNN` rather than write a code unit that
 * cannot render. A surrogate pair is one ordinary code point and is not
 * covered: the pair draws whatever that code point draws.
 *
 * Both blank predicates and the display escaping read these rules, so the
 * package cannot answer the question two ways.
 */
export const BLANK_FILLER_CODE_POINTS: ReadonlySet<number> = new Set([
  0x115f, 0x1160, 0x2800, 0x3164, 0xffa0,
]);

export function isBlankFiller(codePoint: number): boolean {
  return BLANK_FILLER_CODE_POINTS.has(codePoint);
}

/** Whether the code point is one half of a pair with no partner. */
export function isUnpairedSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}
