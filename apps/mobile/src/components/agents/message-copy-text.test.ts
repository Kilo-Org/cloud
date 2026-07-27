import { describe, expect, it } from 'vitest';

import { collectCopyableText } from './collect-copyable-text';

type TestMessage = {
  parts: { type: string; text?: string; url?: string; synthetic?: boolean }[];
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

  it('excludes synthetic snapshot-progress text parts from copy', () => {
    const message: TestMessage = {
      parts: [
        { type: 'text', text: '⠋ Initializing snapshot…', synthetic: true },
        { type: 'text', text: 'Real answer' },
      ],
    };
    expect(collectCopyableText(message)).toBe('Real answer');
  });

  it('keeps non-synthetic text that mentions Initializing snapshot', () => {
    const message: TestMessage = {
      parts: [{ type: 'text', text: 'Note: Initializing snapshot can take a while' }],
    };
    expect(collectCopyableText(message)).toBe('Note: Initializing snapshot can take a while');
  });

  it('keeps synthetic user optimistic text parts', () => {
    const message: TestMessage = {
      parts: [{ type: 'text', text: 'User typed this', synthetic: true }],
    };
    expect(collectCopyableText(message)).toBe('User typed this');
  });
});
