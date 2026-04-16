/** Extract the millisecond timestamp encoded in a ULID's first 10 characters. */
export function ulidToTimestamp(ulid: string): number {
  return parseInt(ulid.slice(0, 10), 36);
}

/** Extract plain text from an array of content blocks. */
export function contentBlocksToText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
