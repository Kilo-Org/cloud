import type { ContentBlock } from '@kilocode/kilo-chat';

/** Concatenates text content blocks into a single string. Skips non-text blocks. */
export function contentBlocksToText(content: ContentBlock[]): string {
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        b.type === 'text' && typeof (b as { text?: unknown }).text === 'string'
    )
    .map(b => b.text)
    .join('');
}
