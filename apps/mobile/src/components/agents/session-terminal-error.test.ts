import { describe, expect, it } from 'vitest';

import {
  buildTerminalErrorCopyText,
  classifyTerminalError,
  resolveSessionTerminalError,
} from './session-terminal-error';

describe('classifyTerminalError', () => {
  it.each([
    ['You are not authorized to use the Cloud Agent.', 'permission'],
    ['Insufficient credits. Please add at least $1 to continue using Cloud Agent.', 'credits'],
    ['Previous task is still finishing up. Please wait a moment.', 'busy'],
    ['Service is unavailable right now. Please try again.', 'unavailable'],
    ['Service is temporarily unavailable. Please retry in a moment.', 'unavailable'],
    ['Connection lost. Please retry in a moment.', 'transient'],
    ['Connection failed. Please retry in a moment.', 'transient'],
    ['Something went wrong. Please retry in a moment.', 'transient'],
    ['some unexpected failure', 'unknown'],
    ['', 'unknown'],
  ] as const)('classifies %s', (message, expected) => {
    expect(classifyTerminalError(message)).toBe(expected);
  });
});

const indicatorFor = (message: string) => ({
  error: null,
  statusIndicator: { type: 'error' as const, message },
  messageCount: 0,
});

describe('resolveSessionTerminalError', () => {
  it('returns null when there are messages', () => {
    expect(
      resolveSessionTerminalError({
        error: 'boom',
        statusIndicator: { type: 'error', message: 'Connection lost. Please retry in a moment.' },
        messageCount: 1,
      })
    ).toBeNull();
  });

  it('returns null when there is no error and no error indicator', () => {
    expect(
      resolveSessionTerminalError({ error: null, statusIndicator: null, messageCount: 0 })
    ).toBeNull();
  });

  it('ignores a non-error indicator', () => {
    expect(
      resolveSessionTerminalError({
        error: null,
        statusIndicator: { type: 'info', message: 'Session stopped' },
        messageCount: 0,
      })
    ).toBeNull();
  });

  it('shows translated copy for the error atom and keeps the original for Copy', () => {
    expect(
      resolveSessionTerminalError({ error: 'boom', statusIndicator: null, messageCount: 0 })
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'Failed to load session details',
      retryable: true,
      detail: 'boom',
    });
  });

  it('never shows the English transport message to the reader', () => {
    const resolved = resolveSessionTerminalError(
      indicatorFor('Connection failed. Please retry in a moment.')
    );
    expect(resolved).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'Connection trouble. Please retry in a moment.',
      retryable: true,
      detail: 'Connection failed. Please retry in a moment.',
    });
  });

  it('classifies a permission indicator as non-retryable', () => {
    expect(
      resolveSessionTerminalError(indicatorFor('You are not authorized to use the Cloud Agent.'))
    ).toEqual({
      variant: 'permission',
      title: 'Access denied',
      message: "You don't have permission to view this.",
      retryable: false,
      detail: 'You are not authorized to use the Cloud Agent.',
    });
  });

  it.each([
    ['Connection lost. Please retry in a moment.', true],
    ['Previous task is still finishing up. Please wait a moment.', true],
    ['Service is unavailable right now. Please try again.', true],
    ['Insufficient credits. Please add at least $1 to continue using Cloud Agent.', false],
    ['You are not authorized to use the Cloud Agent.', false],
    ['some unexpected failure', false],
  ] as const)('offers retry for %s: %s', (message, retryable) => {
    expect(resolveSessionTerminalError(indicatorFor(message))?.retryable).toBe(retryable);
  });
});

describe('buildTerminalErrorCopyText', () => {
  it('joins session id, title, message and the untranslated original', () => {
    expect(
      buildTerminalErrorCopyText({
        sessionId: 'sess-1',
        title: 'Not found',
        message: 'This item was removed.',
        detail: 'HTTP 404',
      })
    ).toBe('sess-1\nNot found\nThis item was removed.\nHTTP 404');
  });

  it('omits empty parts', () => {
    expect(
      buildTerminalErrorCopyText({
        sessionId: 'sess-1',
        title: '',
        message: 'This item was removed.',
      })
    ).toBe('sess-1\nThis item was removed.');
  });

  it('does not repeat a detail that is already the message', () => {
    expect(
      buildTerminalErrorCopyText({
        sessionId: 'sess-1',
        title: 'Title',
        message: 'Same',
        detail: 'Same',
      })
    ).toBe('sess-1\nTitle\nSame');
  });
});
