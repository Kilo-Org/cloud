/** The CLI's `always` prefix without its trailing ` *`, e.g. `git push *` becomes `git push`. */
export function commandKeyFromAlways(always: string): string {
  const trimmed = always.trim();
  if (trimmed === '*') return '*';
  return trimmed.endsWith(' *') ? trimmed.slice(0, -2).trimEnd() : trimmed;
}
