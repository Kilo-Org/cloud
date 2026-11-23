import { isBlankFiller, isUnpairedSurrogate } from './blank-code-points';

/**
 * Display text for a value a person approves: a command, a path pattern, or a
 * tool id. The printed text names every code point that draws nothing of its
 * own, using the spellings a shell reader knows, so two values that look the
 * same do not print the same:
 *
 * - `\n`, `\r` and `\t` for those three, `\xNN` for another control
 *   character, and `\uNNNN` for a line or paragraph separator;
 * - `\uNNNN` for a format character in the Basic Multilingual Plane, and
 *   `\UNNNNNNNN` for one above it;
 * - `\uNNNN` for the fillers U+115F, U+1160, U+2800, U+3164 and U+FFA0, which
 *   are letters or symbols by category and still draw a blank;
 * - `\uNNNN` for an unpaired surrogate, which is half a code point and has no
 *   glyph to print.
 *
 * A backslash in the value prints as two backslashes, so a printed `\uNNNN`
 * always names the character it spells and never text that happens to spell
 * it. A combining mark and the joiners U+200C and U+200D stay as they are:
 * they draw through the letter they belong to, and spelling them out would
 * change the shape of the joined script.
 *
 * Every other code point prints unchanged.
 */
export function displaySafeText(raw: string): string {
  let escaped = '';
  // Iterating code points keeps a surrogate pair whole, so a value with an
  // astral character never becomes two escapes.
  for (const char of raw) {
    escaped += escapeChar(char, char.codePointAt(0) ?? 0);
  }
  return escaped;
}

/**
 * Whether the code point is a format character. The category is used rather
 * than a list, so no member of it is missed. Such a character draws nothing of
 * its own; the separators are covered by {@link NOT_DRAWN} and the blank
 * letters and symbols by {@link isBlankFiller}.
 */
const FORMAT_CHARACTER = /^\p{Cf}$/u;

/**
 * Whether the code point draws nothing and takes no room: a control character
 * or a separator. A format character is covered by {@link FORMAT_CHARACTER}
 * instead.
 */
const NOT_DRAWN = /^(?:\p{Cc}|\p{Z})$/u;

/**
 * Whether the code point is default-ignorable: a variation selector, a
 * combining grapheme joiner, a Mongolian free variation selector, and the rest
 * of the set that draws nothing on its own. Most of them are combining marks by
 * category, so the category alone cannot answer this.
 */
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/** Whether the code point combines with the character before it. */
const COMBINING = /^\p{M}$/u;

/**
 * Whether the value draws at least one glyph. A value made only of code points
 * that draw nothing — a format character, a separator, a filler, a control
 * character, a default-ignorable mark, a lone surrogate — reads as blank, so a
 * surface that shows it as the thing a person confirms would be confirming
 * nothing.
 *
 * A lone joiner U+200C or U+200D counts as invisible: it shapes the letters
 * around it but draws nothing itself, so a value of only joiners is blank. A
 * combining mark draws nothing of its own either, so a value of only marks is
 * blank; a mark beside a letter changes nothing here, because the letter has
 * already answered. An unpaired surrogate is half a code point, so a value of
 * only surrogates is blank; a surrogate pair is one visible code point.
 */
export function hasVisibleGlyph(raw: string): boolean {
  let drawn = false;
  // Iterating code points keeps a surrogate pair whole, so an astral character
  // is judged as the one code point it is.
  for (const char of raw) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isUnpairedSurrogate(codePoint) || isBlankFiller(codePoint)) continue;
    if (FORMAT_CHARACTER.test(char) || NOT_DRAWN.test(char) || DEFAULT_IGNORABLE.test(char))
      continue;
    // A mark with nothing to attach to paints nothing; one that follows a drawn
    // character is part of what that character draws.
    if (COMBINING.test(char)) continue;
    drawn = true;
  }
  return drawn;
}

function escapeChar(char: string, code: number): string {
  // A backslash prints as two, so the printed text keeps one reading: the
  // characters it names are the characters of the value.
  if (code === 0x5c) return '\\\\';
  if (code === 0x0a) return '\\n';
  if (code === 0x0d) return '\\r';
  if (code === 0x09) return '\\t';
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  // Half a code point has no glyph to print; the four-digit escape is the only
  // reading of it. This comes before the joiner test because a joiner is a
  // whole code point.
  if (isUnpairedSurrogate(code)) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  const drawsNothing =
    isBlankFiller(code) || code === 0x2028 || code === 0x2029 || FORMAT_CHARACTER.test(char);
  if (!drawsNothing) return char;
  // The joiners shape the letters around them instead of drawing a glyph, so
  // they stay: spelling them out would misdraw the joined script.
  if (code === 0x200c || code === 0x200d) return char;
  if (code <= 0xffff) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `\\U${code.toString(16).padStart(8, '0').toUpperCase()}`;
}
