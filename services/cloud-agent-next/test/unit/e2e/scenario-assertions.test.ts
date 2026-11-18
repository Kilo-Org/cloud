import { describe, expect, it } from 'vitest';

import {
  assertMessageLifecycle,
  assertReaderCannotDeriveNonce,
  parseFileReadEcho,
} from '../../e2e/scenario-assertions.js';
import type { StreamConnection } from '../../e2e/client.js';

type TestEvent = { streamEventType: string; messageId?: string };

function streamWith(events: TestEvent[]): StreamConnection {
  return {
    events: events.map(event => ({
      streamEventType: event.streamEventType,
      data: event.messageId === undefined ? {} : { messageId: event.messageId },
    })),
  } as unknown as StreamConnection;
}

const MESSAGE = 'msg_lifecycle';

describe('assertMessageLifecycle', () => {
  it('returns the ordered queued>sent>completed phases', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.queued', messageId: MESSAGE },
      { streamEventType: 'cloud.message.sent', messageId: MESSAGE },
      { streamEventType: 'cloud.message.completed', messageId: MESSAGE },
    ]);
    expect(assertMessageLifecycle(stream, MESSAGE, 'turn')).toBe(
      'cloud.message.queued>cloud.message.sent>cloud.message.completed'
    );
  });

  it('rejects a failed lifecycle', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.queued', messageId: MESSAGE },
      { streamEventType: 'cloud.message.failed', messageId: MESSAGE },
    ]);
    expect(() => assertMessageLifecycle(stream, MESSAGE, 'turn')).toThrow(/failed lifecycle/);
  });

  it('rejects a missing sent event', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.queued', messageId: MESSAGE },
      { streamEventType: 'cloud.message.completed', messageId: MESSAGE },
    ]);
    expect(() => assertMessageLifecycle(stream, MESSAGE, 'turn')).toThrow(/no cloud.message.sent/);
  });

  it('rejects a missing completed event', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.queued', messageId: MESSAGE },
      { streamEventType: 'cloud.message.sent', messageId: MESSAGE },
    ]);
    expect(() => assertMessageLifecycle(stream, MESSAGE, 'turn')).toThrow(
      /no cloud.message.completed after sent/
    );
  });

  it('rejects a missing queued event', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.sent', messageId: MESSAGE },
      { streamEventType: 'cloud.message.completed', messageId: MESSAGE },
    ]);
    expect(() => assertMessageLifecycle(stream, MESSAGE, 'turn')).toThrow(
      /no cloud.message.queued/
    );
  });

  it('rejects queued arriving after sent', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.sent', messageId: MESSAGE },
      { streamEventType: 'cloud.message.queued', messageId: MESSAGE },
      { streamEventType: 'cloud.message.completed', messageId: MESSAGE },
    ]);
    expect(() => assertMessageLifecycle(stream, MESSAGE, 'turn')).toThrow(
      /queued did not precede sent/
    );
  });

  it('ignores lifecycle events for other messages', () => {
    const stream = streamWith([
      { streamEventType: 'cloud.message.queued', messageId: 'msg_other' },
      { streamEventType: 'cloud.message.queued', messageId: MESSAGE },
      { streamEventType: 'cloud.message.sent', messageId: MESSAGE },
      { streamEventType: 'cloud.message.completed', messageId: MESSAGE },
    ]);
    expect(assertMessageLifecycle(stream, MESSAGE, 'turn')).toBe(
      'cloud.message.queued>cloud.message.sent>cloud.message.completed'
    );
  });
});

describe('parseFileReadEcho', () => {
  it('returns the body after the exact header line', () => {
    expect(parseFileReadEcho('file-read:shared.txt\nnonce-value', 'shared.txt')).toBe(
      'nonce-value'
    );
  });

  it('returns a multi-line body intact', () => {
    expect(parseFileReadEcho('file-read:a.txt\nfirst\nsecond\nthird', 'a.txt')).toBe(
      'first\nsecond\nthird'
    );
  });

  it('finds the header when it is not the first line and preserves trailing bytes', () => {
    expect(parseFileReadEcho('prefix\nfile-read:a.txt\nbody\n', 'a.txt')).toBe('body\n');
  });

  it('returns null when the exact header is absent', () => {
    expect(parseFileReadEcho('file-read:other.txt\nbody', 'a.txt')).toBeNull();
    expect(parseFileReadEcho('no echo here', 'a.txt')).toBeNull();
  });

  it('does not match a prefix of a longer path', () => {
    expect(parseFileReadEcho('file-read:shared.txt.bak\nbody', 'shared.txt')).toBeNull();
  });

  it('requires the exact header line without trailing whitespace', () => {
    expect(parseFileReadEcho('file-read:a.txt \nbody', 'a.txt')).toBeNull();
    expect(parseFileReadEcho('\tfile-read:a.txt\nbody', 'a.txt')).toBeNull();
  });
});

describe('assertReaderCannotDeriveNonce', () => {
  it('accepts a body equal to the writer-only nonce', () => {
    expect(() =>
      assertReaderCannotDeriveNonce({
        body: 'nonce-abc',
        expectedNonce: 'nonce-abc',
        readerVisible: 'nonce-from-shared.txt-rb1',
        label: 'read one',
      })
    ).not.toThrow();
  });

  it('rejects a body synthesized only from the reader path/tag', () => {
    const readerVisible = 'nonce-from-shared.txt-rb1';
    expect(() =>
      assertReaderCannotDeriveNonce({
        body: readerVisible,
        expectedNonce: 'nonce-abc',
        readerVisible,
        label: 'read one',
      })
    ).toThrow(/reader-derived value/);
  });

  it('rejects a body that is neither the nonce nor reader-derived', () => {
    expect(() =>
      assertReaderCannotDeriveNonce({
        body: 'something-else',
        expectedNonce: 'nonce-abc',
        readerVisible: 'nonce-from-shared.txt-rb1',
        label: 'read one',
      })
    ).toThrow(/expected the writer's private nonce/);
  });
});
