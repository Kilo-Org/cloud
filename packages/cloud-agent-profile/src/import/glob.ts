const REGEXP_SPECIAL_CHARACTERS = new Set([
  '\\',
  '^',
  '$',
  '.',
  '|',
  '+',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
]);

/**
 * Translate a `kilo.json` instruction glob into an anchored RegExp:
 * `**` spans path separators, `*` and `?` stay inside one segment.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  let source = '^';
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += REGEXP_SPECIAL_CHARACTERS.has(char) ? `\\${char}` : char;
    index += 1;
  }
  return new RegExp(`${source}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}
