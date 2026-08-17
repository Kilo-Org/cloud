import { describe, expect, it } from 'vitest';

import {
  buildTerminalErrorCopyText,
  classifyTerminalError,
  resolveSessionTerminalError,
} from './session-terminal-error';

describe('classifyTerminalError', () => {
  it('classifies the permission string', () => {
    expect(classifyTerminalError('You are not authorized to use the Cloud Agent.')).toBe(
      'permission'
    );
  });

  it('classifies the not-found string', () => {
    expect(classifyTerminalError('Service is unavailable right now. Please try again.')).toBe(
      'not-found'
    );
  });

  it('classifies connection-loss as transient', () => {
    expect(classifyTerminalError('Connection lost. Please retry in a moment.')).toBe('transient');
    expect(classifyTerminalError('Connection failed. Please retry in a moment.')).toBe('transient');
  });

  it('classifies service-unavailable as transient', () => {
    expect(
      classifyTerminalError('Service is temporarily unavailable. Please retry in a moment.')
    ).toBe('transient');
  });

  it('classifies the generic retry string as transient', () => {
    expect(classifyTerminalError('Something went wrong. Please retry in a moment.')).toBe(
      'transient'
    );
  });

  it('classifies unrecognized text as unknown', () => {
    expect(classifyTerminalError('Insufficient credits. Please add at least $1.')).toBe('unknown');
    expect(
      classifyTerminalError('Previous task is still finishing up. Please wait a moment.')
    ).toBe('unknown');
    expect(classifyTerminalError('')).toBe('unknown');
    expect(classifyTerminalError('some unexpected failure')).toBe('unknown');
  });
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

  it('treats the error atom as a retryable server failure', () => {
    expect(
      resolveSessionTerminalError({ error: 'boom', statusIndicator: null, messageCount: 0 })
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'boom',
      copyable: true,
      retryable: true,
    });
  });

  it('classifies a permission indicator as non-retryable', () => {
    expect(
      resolveSessionTerminalError({
        error: null,
        statusIndicator: {
          type: 'error',
          message: 'You are not authorized to use the Cloud Agent.',
        },
        messageCount: 0,
      })
    ).toEqual({
      variant: 'permission',
      title: 'Access denied',
      message: 'You are not authorized to use the Cloud Agent.',
      copyable: true,
      retryable: false,
    });
  });

  it('classifies a not-found indicator as non-retryable', () => {
    expect(
      resolveSessionTerminalError({
        error: null,
        statusIndicator: {
          type: 'error',
          message: 'Service is unavailable right now. Please try again.',
        },
        messageCount: 0,
      })
    ).toEqual({
      variant: 'not-found',
      title: 'Not found',
      message: 'Service is unavailable right now. Please try again.',
      copyable: true,
      retryable: false,
    });
  });

  it('classifies a transient indicator as retryable', () => {
    expect(
      resolveSessionTerminalError({
        error: null,
        statusIndicator: {
          type: 'error',
          message: 'Connection lost. Please retry in a moment.',
        },
        messageCount: 0,
      })
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'Connection lost. Please retry in a moment.',
      copyable: true,
      retryable: true,
    });
  });

  it('treats an unknown indicator as non-retryable (permanent is safer)', () => {
    expect(
      resolveSessionTerminalError({
        error: null,
        statusIndicator: { type: 'error', message: 'some unexpected failure' },
        messageCount: 0,
      })
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'some unexpected failure',
      copyable: true,
      retryable: false,
    });
  });
});

const indicatorFor = (message: string) => ({
  error: null,
  statusIndicator: { type: 'error' as const, message },
  messageCount: 0,
});

describe('resolveSessionTerminalError Copy / Retry presence', () => {
  it.each([
    ['not-found', 'Service is unavailable right now. Please try again.'],
    ['permission', 'You are not authorized to use the Cloud Agent.'],
    ['transient', 'Connection lost. Please retry in a moment.'],
    ['unknown', 'some unexpected failure'],
  ] as const)('offers Copy for the %s class', (_cls, message) => {
    const resolved = resolveSessionTerminalError(indicatorFor(message));
    expect(resolved?.copyable).toBe(true);
  });

  it('offers Retry only for the transient class', () => {
    expect(
      resolveSessionTerminalError(indicatorFor('Connection lost. Please retry in a moment.'))
        ?.retryable
    ).toBe(true);
  });

  it.each([
    ['not-found', 'Service is unavailable right now. Please try again.'],
    ['permission', 'You are not authorized to use the Cloud Agent.'],
    ['unknown', 'some unexpected failure'],
  ] as const)('hides Retry for the %s class', (_cls, message) => {
    const resolved = resolveSessionTerminalError(indicatorFor(message));
    expect(resolved?.retryable).toBe(false);
  });
});

describe('buildTerminalErrorCopyText', () => {
  it('joins session id, title, and message with newlines', () => {
    expect(buildTerminalErrorCopyText('sess-1', 'Not found', 'This item was removed.')).toBe(
      'sess-1\nNot found\nThis item was removed.'
    );
  });

  it('omits empty parts', () => {
    expect(buildTerminalErrorCopyText('sess-1', '', 'This item was removed.')).toBe(
      'sess-1\nThis item was removed.'
    );
  });
});
