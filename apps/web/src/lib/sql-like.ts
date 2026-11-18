/** Escapes `%`, `_` and `\` so a value matches literally inside a LIKE pattern. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}
