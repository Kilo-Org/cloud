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
 *   are letters or symbols by category and still draw a blank.
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
 * Whether the code point draws nothing of its own: a format character, a line
 * or paragraph separator, or a filler that is a letter or symbol by category
 * and still draws a blank. The format group is matched by category rather than
 * by a list of code points, so no member of it is missed. A combining mark is
 * absent on purpose: it draws through the letter it follows, and the caller
 * keeps it.
 */
const INVISIBLE = /^(?:\p{Cf}|\p{Zl}|\p{Zp}|[\u115F\u1160\u2800\u3164\uFFA0])$/u;

/**
 * Whether the code point draws nothing and takes no room: a control character
 * or a separator. A format character is covered by {@link INVISIBLE} instead.
 */
const NOT_DRAWN = /^(?:\p{Cc}|\p{Z})$/u;

/**
 * Whether the value draws at least one glyph. A value made only of code points
 * that draw nothing — a format character, a separator, a filler, a control
 * character — reads as blank, so a surface that shows it as the thing a person
 * confirms would be confirming nothing.
 *
 * A lone joiner U+200C or U+200D counts as invisible: it shapes the letters
 * around it but draws nothing itself, so a value of only joiners is blank. A
 * combining mark is not excluded: it draws through the letter it follows, and
 * even without one it still paints a mark.
 */
export function hasVisibleGlyph(raw: string): boolean {
  // Iterating code points keeps a surrogate pair whole, so an astral character
  // is judged as the one code point it is.
  for (const char of raw) {
    if (INVISIBLE.test(char) || NOT_DRAWN.test(char)) continue;
    return true;
  }
  return false;
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
  if (!INVISIBLE.test(char)) return char;
  // The joiners shape the letters around them instead of drawing a glyph, so
  // they stay: spelling them out would misdraw the joined script.
  if (code === 0x200c || code === 0x200d) return char;
  if (code <= 0xffff) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `\\U${code.toString(16).padStart(8, '0').toUpperCase()}`;
}
