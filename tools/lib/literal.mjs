/**
 * Encodes a value as a single-quoted string literal that holds it as data.
 *
 * JSON.stringify supplies the escaping for quotes, backslashes and control
 * characters; its double quotes are unescaped and single quotes escaped, so the
 * literal keeps the repository's single-quote style. Both mobile generators call
 * this, so the escaping contract for committed generated sources has one edit
 * site.
 */
export function formatSingleQuotedLiteral(value) {
  const escaped = JSON.stringify(value)
    .slice(1, -1)
    .replaceAll(String.raw`\"`, '"')
    .replaceAll("'", String.raw`\'`);
  return `'${escaped}'`;
}
