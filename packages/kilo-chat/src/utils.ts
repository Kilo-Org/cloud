import { decodeTime } from 'ulid';

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidToTimestamp(ulid: string): number {
  return decodeTime(ulid);
}

/**
 * Extract plain text from an array of content blocks.
 *
 * Concatenates adjacent text blocks without a separator. Long replies are
 * split across multiple text blocks at arbitrary UTF-16 boundaries by the
 * producer (see services/kiloclaw/plugins/kilo-chat/src/preview-stream.ts),
 * so any separator here would inject stray characters into the reconstructed
 * message text.
 */
export function contentBlocksToText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}
