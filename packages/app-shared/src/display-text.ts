/**
 * Display text for a value a person approves: a command, a path pattern, or a
 * tool id. The text spells out every code point of the value, so a reader sees
 * the same characters the session holds. The spellings are the ones a shell
 * reader knows: `\n`, `\r`, `\t`, `\xNN` for a control character and `\uNNNN`
 * for a format character. The permission prompt of the CLI prints the same
 * spellings, so one request reads the same way wherever a person decides it.
 *
 * The joiners U+200C and U+200D stay as they are: they draw nothing themselves
 * but shape the letters of a joined script, and spelling them out would misdraw
 * Arabic, Hebrew and the Indic scripts.
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

function escapeChar(char: string, code: number): string {
  if (code === 0x0a) return '\\n';
  if (code === 0x0d) return '\\r';
  if (code === 0x09) return '\\t';
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  if (isFormatControl(code)) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return char;
}

/**
 * Whether the code point is one the helper prints as an escape although it is
 * not a control character: a code point that draws no glyph and shapes no letter
 * of its neighbour, so the printed text would otherwise not state it. Compared
 * numerically because a character class naming these code points reads in the
 * source as the characters themselves.
 */
function isFormatControl(code: number): boolean {
  return (
    // Arabic letter mark.
    code === 0x061c ||
    // Zero-width space, left-to-right mark, right-to-left mark.
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    // Line separator, paragraph separator.
    code === 0x2028 ||
    code === 0x2029 ||
    // Directional embeddings, overrides and their pop.
    (code >= 0x202a && code <= 0x202e) ||
    // Word joiner and the invisible operators.
    (code >= 0x2060 && code <= 0x2064) ||
    // Directional isolates and their pop.
    (code >= 0x2066 && code <= 0x2069) ||
    // Byte order mark.
    code === 0xfeff
  );
}