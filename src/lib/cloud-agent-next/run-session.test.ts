/**
 * Tests for run-session.ts
 *
 * Tests the pure helper functions (resolveStreamUrl, extractTextFromMessage)
 * exported from run-session.ts.
 */

import { resolveStreamUrl, extractTextFromMessage } from './run-session';
import type { ProcessedMessage } from './processor';

// ─── resolveStreamUrl ───────────────────────────────────────────────

describe('resolveStreamUrl', () => {
  it('throws when streamUrl is empty', () => {
    expect(() => resolveStreamUrl('')).toThrow('Cloud Agent stream URL is missing');
  });

  it('returns an absolute wss:// URL when given an absolute https:// URL', () => {
    const result = resolveStreamUrl('https://agent.example.com/stream?id=123');
    expect(result).toBe('wss://agent.example.com/stream?id=123');
  });

  it('returns an absolute ws:// URL when given an absolute http:// URL', () => {
    const result = resolveStreamUrl('http://agent.example.com/stream');
    expect(result).toBe('ws://agent.example.com/stream');
  });

  it('passes through an already-wss URL unchanged', () => {
    const result = resolveStreamUrl('wss://agent.example.com/stream');
    expect(result).toBe('wss://agent.example.com/stream');
  });
});

// ─── extractTextFromMessage ─────────────────────────────────────────

function makeMessage(parts: ProcessedMessage['parts']): ProcessedMessage {
  return {
    info: {
      id: 'msg-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: Date.now() },
    },
    parts,
  };
}

describe('extractTextFromMessage', () => {
  it('returns empty string when message has no parts', () => {
    expect(extractTextFromMessage(makeMessage([]))).toBe('');
  });

  it('extracts text from a single text part', () => {
    const message = makeMessage([
      { id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'PR opened at https://github.com/org/repo/pull/42' },
    ]);
    expect(extractTextFromMessage(message)).toBe(
      'PR opened at https://github.com/org/repo/pull/42'
    );
  });

  it('concatenates multiple text parts', () => {
    const message = makeMessage([
      { id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'Changes applied. ' },
      { id: 'p2', sessionID: 's1', messageID: 'm1', type: 'text', text: 'PR: https://github.com/org/repo/pull/42' },
    ]);
    expect(extractTextFromMessage(message)).toBe(
      'Changes applied. PR: https://github.com/org/repo/pull/42'
    );
  });

  it('ignores non-text parts like tool parts', () => {
    const message = makeMessage([
      {
        id: 'p1',
        sessionID: 's1',
        messageID: 'm1',
        type: 'tool',
        call: { id: 'call-1', name: 'bash', input: '{}' },
      } as ProcessedMessage['parts'][number],
      { id: 'p2', sessionID: 's1', messageID: 'm1', type: 'text', text: 'Done!' },
    ]);
    expect(extractTextFromMessage(message)).toBe('Done!');
  });

  it('trims whitespace from the final result', () => {
    const message = makeMessage([
      { id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: '  Hello  ' },
    ]);
    expect(extractTextFromMessage(message)).toBe('Hello');
  });
});
