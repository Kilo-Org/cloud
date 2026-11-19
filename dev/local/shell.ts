/**
 * POSIX single-quoting for the command strings this directory types into a tmux
 * pane, which runs them through `/bin/sh -lc`. A quoted value reaches the shell
 * as one word, so a checkout path with a space in it stays one word too.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
