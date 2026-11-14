/**
 * A code point a reader can see. A separator, a control, a zero-width or
 * direction mark, or a combining mark draws nothing on its own, so a value made
 * of them is as empty as one made of spaces. A code point this engine's Unicode
 * tables do not classify yet matches (it is neither Cc, Cf, Z nor M), so a
 * message that is a brand-new emoji stays a message.
 */
const RENDERS = /[^\p{Cc}\p{Cf}\p{Z}\p{M}]/u;

/**
 * Fillers that draw nothing and are still letters or symbols by category: the
 * Hangul fillers and the braille blank. They are the shapes a "blank" value is
 * usually padded with.
 */
const INVISIBLE_FILLER = /[\u115F\u1160\u2800\u3164\uFFA0]/u;

/**
 * Whether a value carries anything a reader can see.
 *
 * `String.prototype.trim()` answers a narrower question: it removes Unicode
 * whitespace and keeps the zero-width and control characters that draw nothing,
 * which is how a name or a message of spaces and zero-width spaces looked empty
 * on screen and still saved. Every gate that asks "did the person write
 * anything?" reads this instead, so the fields, the buttons and the server
 * agree on what a blank value is.
 */
export function hasVisibleText(value: string): boolean {
  for (const character of value) {
    if (!INVISIBLE_FILLER.test(character) && RENDERS.test(character)) {
      return true;
    }
  }
  return false;
}
