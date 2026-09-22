/**
 * Plain copy for a native `Text`. The catalogs mark commands and paths with
 * backticks, and nothing in the app renders that markup, so the reader sees the
 * punctuation itself. English ships without markers; the translation slice
 * removes them from the other catalogs, and this keeps those readable first.
 */
export function stripInlineCodeMarkers(value: string): string {
  return value.replaceAll('`', '');
}
