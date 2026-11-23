import { firstGraphemes } from '@/lib/graphemes';

export function getFilename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function getDirectoryName(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

/**
 * `text` cut to at most `maxLength` user-perceived characters, with at most one
 * trailing ellipsis.
 *
 * `maxLength` counts characters as the segmenter sees them, and the cut ends on
 * a whole cluster, so a family emoji or a combining mark is never left half
 * written. The ellipsis means a cut happened; a string that fits keeps its
 * characters.
 */
export function truncateText(text: string, maxLength: number): string {
  // No longer than the cap in code units means no more characters than that,
  // so the common short label never reaches the segmenter.
  if (text.length <= maxLength) {
    return text;
  }
  const head = firstGraphemes(text, maxLength);
  // Code units past the cap can still be fewer characters than the cap, and
  // then every character stays.
  return head.more ? `${head.text}\u2026` : text;
}
