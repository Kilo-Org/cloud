import { describe, expect, it } from 'vitest';
import { toTextContentBlocks } from './kilo-chat-write-client';

describe('toTextContentBlocks', () => {
  it('keeps short text in a single block', () => {
    const blocks = toTextContentBlocks('hello');
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('keeps text at exactly the cap in a single block', () => {
    const text = 'a'.repeat(8000);
    const blocks = toTextContentBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(text);
  });

  it('splits oversized text into blocks no larger than the cap', () => {
    const text = 'x'.repeat(8000 * 2 + 123);
    const blocks = toTextContentBlocks(text);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block.type).toBe('text');
      expect(block.text.length).toBeLessThanOrEqual(8000);
    }
    // The chat client re-joins a message's text blocks with no separator,
    // so the concatenation must reproduce the original text exactly.
    expect(blocks.map(b => b.text).join('')).toBe(text);
  });
});
