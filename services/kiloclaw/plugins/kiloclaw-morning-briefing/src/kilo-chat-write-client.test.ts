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

  it('keeps text filling exactly 20 blocks intact', () => {
    const text = 'y'.repeat(8000 * 20);
    const blocks = toTextContentBlocks(text);
    expect(blocks).toHaveLength(20);
    expect(blocks.map(b => b.text).join('')).toBe(text);
  });

  it('truncates text past the 20-block message limit with a marker', () => {
    const text = 'z'.repeat(8000 * 20 + 5000);
    const blocks = toTextContentBlocks(text);
    // Never more than the 20-block per-message cap Kilo Chat enforces.
    expect(blocks).toHaveLength(20);
    for (const block of blocks) {
      expect(block.text.length).toBeLessThanOrEqual(8000);
    }
    const joined = blocks.map(b => b.text).join('');
    expect(joined.length).toBe(8000 * 20);
    expect(joined.endsWith('[Briefing truncated.]')).toBe(true);
  });
});
