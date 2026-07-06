import { describe, expect, it } from 'vitest';

import { collectCopyableText } from './collect-copyable-text';

type TestMessage = {
  parts: { type: string; text?: string; url?: string }[];
};

describe('collectCopyableText', () => {
  it('joins text parts and ignores non-text parts', () => {
    const message: TestMessage = {
      parts: [
        { type: 'text', text: 'Hello' },
        { type: 'file', url: 'x' },
        { type: 'text', text: 'world' },
      ],
    };
    expect(collectCopyableText(message)).toBe('Hello\n\nworld');
  });

  it('returns empty string when no text parts', () => {
    const message: TestMessage = {
      parts: [{ type: 'file', url: 'x' }],
    };
    expect(collectCopyableText(message)).toBe('');
  });
});
