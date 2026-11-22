/**
 * The two code-point rules that every blank-value answer in this package reads,
 * so each has one spelling instead of one per caller.
 *
 * The first rule is the fillers. They are letters or symbols by category and
 * still draw a blank: the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, and
 * the braille blank U+2800. They are the shapes a blank value is usually padded
 * with.
 *
 * The second rule is the unpaired surrogate. It counts as blank: it is half a
 * code point, has no glyph, and printed text spells it `\uNNNN` rather than
 * write a code unit that cannot render. A surrogate pair is one ordinary code
 * point and neither rule covers it; the pair draws whatever that code point
 * draws.
 *
 * The code points that are default-ignorable but neither a mark nor a format
 * character — U+2065, U+FFF0–FFF8, and the unassigned code points of the
 * U+E0000–E0FFF range, whose assigned members are format characters already
 * covered — are deliberately not covered. `hasVisibleText` keeps them visible
 * and `hasVisibleGlyph` keeps them blank, which is the answer each gate already
 * gave: counting them blank everywhere would start refusing organization names,
 * directory-sync names and composer text that carry them. Deciding that for
 * those gates is its own change, so the difference stays and is named here
 * rather than left implicit.
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
