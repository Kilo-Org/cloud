/**
 * The bundled changelog split at its `## ` release headings, in file order.
 * The screen renders one chunk per list item so the markdown renderer parses
 * only the chunks in the list's window: `CHANGELOG.md` grows with every release
 * and the whole history parsed synchronously on open is work nobody sees.
 * Concatenating the chunks returns the source bytes unchanged.
 */
export function splitChangelogSections(markdown: string): string[] {
  return markdown.split(/^(?=## )/m);
}
