/** POSIX single-quote escaping: wraps `value` in single quotes, escaping any embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
