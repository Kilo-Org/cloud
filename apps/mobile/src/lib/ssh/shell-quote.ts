/** A value as one word in a POSIX shell command line. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
