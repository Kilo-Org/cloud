export type FrontmatterDelimiter = '---' | '+++';

export type FrontmatterBlock =
  | { status: 'none' }
  | { status: 'unterminated'; delimiter: FrontmatterDelimiter }
  | { status: 'ok'; delimiter: FrontmatterDelimiter; block: string; body: string };

/** The delimiter a line carries, ignoring one trailing `\r` and trailing blanks. */
function delimiterOf(line: string): FrontmatterDelimiter | null {
  const withoutCarriageReturn = line.endsWith('\r') ? line.slice(0, -1) : line;
  const bare = withoutCarriageReturn.replace(/[ \t]+$/, '');
  if (bare === '---' || bare === '+++') return bare;
  return null;
}

/**
 * Locate the frontmatter block of a markdown document. The closing line must
 * carry the same delimiter as the opening line.
 */
export function locateFrontmatterBlock(markdown: string): FrontmatterBlock {
  const firstLineEnd = markdown.indexOf('\n');
  if (firstLineEnd === -1) return { status: 'none' };

  const delimiter = delimiterOf(markdown.slice(0, firstLineEnd));
  if (delimiter === null) return { status: 'none' };

  let lineStart = firstLineEnd + 1;
  while (lineStart <= markdown.length) {
    const lineEnd = markdown.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? markdown.length : lineEnd;
    if (delimiterOf(markdown.slice(lineStart, end)) === delimiter) {
      return {
        status: 'ok',
        delimiter,
        block: markdown.slice(firstLineEnd + 1, lineStart - 1),
        body: lineEnd === -1 ? '' : markdown.slice(lineEnd + 1),
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return { status: 'unterminated', delimiter };
}
