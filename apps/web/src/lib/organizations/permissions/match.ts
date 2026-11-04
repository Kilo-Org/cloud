/**
 * `glob-v1`, mirroring the Kilo CLI's `packages/core/src/util/wildcard.ts`: anchored, `*` matches
 * any run of characters including newlines, `?` matches one UTF-16 code unit (like a non-unicode RegExp `.`), `\` is treated as `/`, and
 * a trailing ` *` also matches the bare command. Implemented without regular expressions so
 * worst-case time is O(pattern × input) instead of exponential backtracking.
 */
export function matchesGlob(input: string, pattern: string): boolean {
  const text = input.replaceAll('\\', '/');
  const glob = pattern.replaceAll('\\', '/');
  if (matchChars(text, glob)) return true;
  const n = glob.length;
  return (
    n >= 2 && glob[n - 1] === '*' && glob[n - 2] === ' ' && matchChars(text, glob.slice(0, -2))
  );
}

function matchChars(text: string, glob: string): boolean {
  let t = 0;
  let g = 0;
  let starG = -1;
  let starT = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] !== '*' && (glob[g] === '?' || glob[g] === text[t])) {
      t++;
      g++;
    } else if (g < glob.length && glob[g] === '*') {
      starG = g++;
      starT = t;
    } else if (starG !== -1) {
      g = starG + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}
