import { isBlankFiller, isUnpairedSurrogate } from './blank-code-points';

/**
 * A code point a reader can see. A separator, a control, a zero-width or
 * direction mark, a combining mark, or an unpaired surrogate draws nothing on
 * its own, so a value made of them is as empty as one made of spaces. A
 * surrogate pair is one visible code point. A code point this engine's Unicode
 * tables do not classify yet matches (it is none of Cc, Cf, Z or M), so a
 * message that is a brand-new emoji stays a message.
 *
 * The class names no surrogate category: `./blank-code-points` owns the
 * unpaired surrogate and filler decisions, and the loop asks that module
 * before testing this class.
 */
const RENDERS = /[^\p{Cc}\p{Cf}\p{Z}\p{M}]/u;

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
    const codePoint = character.codePointAt(0) ?? 0;
    if (isUnpairedSurrogate(codePoint) || isBlankFiller(codePoint)) continue;
    if (RENDERS.test(character)) return true;
  }
  return false;
}
