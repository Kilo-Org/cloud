import { describe, expect, it } from 'vitest';

import { type MessageFailure } from './message-failure-state';
import {
  buildTerminalErrorCopyText,
  classifyTerminalError,
  resolveSessionTerminalError,
  sessionStatusErrorMessage,
  statusIndicatorDuplicatesMessageFailure,
} from './session-terminal-error';

describe('classifyTerminalError', () => {
  it.each([
    ['You are not authorized to use the Cloud Agent.', 'permission'],
    ['Insufficient credits. Please add at least $1 to continue using Cloud Agent.', 'credits'],
    // The Durable Object's safe projection lowercases the phrase; the same
    // failure must classify the same way.
    ['Assistant request failed: insufficient credits', 'credits'],
    ['Previous task is still finishing up. Please wait a moment.', 'busy'],
    [
      'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.',
      'model',
    ],
    ['This session is no longer available.', 'gone'],
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
    // A Retry cannot recover either of these: the user has to change the model
    // or leave the session.
    [
      'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.',
      false,
    ],
    ['This session is no longer available.', false],
  ] as const)('offers retry for %s: %s', (message, retryable) => {
    expect(resolveSessionTerminalError(indicatorFor(message))?.retryable).toBe(retryable);
  });

  it('keeps the selected-model error out of the service-outage class', () => {
    expect(
      resolveSessionTerminalError(
        indicatorFor(
          'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.'
        )
      )
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: "This model isn't available for Cloud Agent. Choose another model and try again.",
      retryable: false,
      detail:
        'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.',
    });
  });

  it('shows a gone session as not found', () => {
    expect(
      resolveSessionTerminalError(indicatorFor('This session is no longer available.'))
    ).toEqual({
      variant: 'not-found',
      title: 'Not found',
      message: 'This item may have been removed or is no longer available.',
      retryable: false,
      detail: 'This session is no longer available.',
    });
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

describe('sessionStatusErrorMessage', () => {
  it.each([
    ['simulated error', 'The response failed.'],
    ['Unauthorized: Unauthorized', 'The response failed.'],
    [
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
      'Not enough credits to run Cloud Agent. Add credits and try again.',
    ],
    // The DO's safe projection is the producer for a real credits failure; it
    // writes the phrase lowercase.
    [
      'Assistant request failed: insufficient credits',
      'Not enough credits to run Cloud Agent. Add credits and try again.',
    ],
    // Both SDK status strings for a failed delivery reach the delivery copy:
    // session-manager's exhaustion indicator and the cloud status written for
    // `cloud.message.failed` (also the normalizer's fallback).
    ['Message failed to deliver', 'Failed to deliver'],
    ['Message delivery failed', 'Failed to deliver'],
  ] as const)('maps %s to typed copy', (raw, expected) => {
    expect(sessionStatusErrorMessage(raw)).toBe(expected);
  });

  // The SDK writes these strings itself, so they are already the reader's copy
  // and must not be replaced by the generic failure line.
  it.each([
    ['Agent connection lost'],
    ['Session terminated'],
    ['Failed to stop execution'],
  ] as const)('shows the SDK fixed copy for %s', raw => {
    expect(sessionStatusErrorMessage(raw)).toBe(raw);
  });

  // The Durable Object's safe failure projection is the reader's copy too
  // (services/cloud-agent-next/src/session/safe-failure-projection.ts, and the
  // assistant failures it re-exports from src/shared/assistant-failure.ts).
  // None match a classifier rule, so each must pass through unchanged instead
  // of collapsing to the assistant-failure line.
  it.each([
    ['Workspace setup failed'],
    ['Repository authentication failed'],
    [
      'GitHub repository authentication failed. Check that the GitHub App is installed and has access to this repository.',
    ],
    ['Could not connect to the sandbox'],
    ['No model was selected'],
    ['Agent wrapper disconnected'],
    ['Assistant request failed: model not found'],
    ['Assistant request was rate limited'],
    ['Session metadata is unavailable'],
    ['Commit failed'],
    // A bounded workspace failure appends its own detail to the projection.
    ['Workspace setup failed: Devcontainer workspace preparation failed'],
  ] as const)('shows the safe projection copy for %s', raw => {
    expect(sessionStatusErrorMessage(raw)).toBe(raw);
  });

  it('never returns the raw provider text', () => {
    const raw = 'Service Unavailable: The service is temporarily unavailable.';
    expect(sessionStatusErrorMessage(raw)).not.toContain('Service Unavailable');
  });
});

function assistantFailure(detail: string | null): MessageFailure {
  return {
    kind: 'assistant',
    title: 'Response failed',
    detail,
    copyDetail: '',
    canRetry: true,
    canCopy: false,
  };
}

describe('statusIndicatorDuplicatesMessageFailure', () => {
  const deliveryFailure: MessageFailure = {
    kind: 'delivery',
    title: 'Failed to deliver',
    detail: 'We could not deliver this message after several attempts.',
    copyDetail: 'Unauthorized: Unauthorized',
    canRetry: true,
    canCopy: true,
  };

  it('suppresses an unclassified session error the last row already states', () => {
    expect(
      statusIndicatorDuplicatesMessageFailure({
        indicator: { type: 'error', message: 'simulated error' },
        failure: assistantFailure(null),
      })
    ).toBe(true);
  });

  it('suppresses the delivery line the last row already states', () => {
    expect(
      statusIndicatorDuplicatesMessageFailure({
        indicator: { type: 'error', message: 'Message failed to deliver' },
        failure: deliveryFailure,
      })
    ).toBe(true);
  });

  it('keeps a classified line the row does not carry', () => {
    expect(
      statusIndicatorDuplicatesMessageFailure({
        indicator: {
          type: 'error',
          message: 'Assistant request failed: insufficient credits',
        },
        failure: assistantFailure(null),
      })
    ).toBe(false);
  });

  it('keeps the line when the row renders no failure footer', () => {
    expect(
      statusIndicatorDuplicatesMessageFailure({
        indicator: { type: 'error', message: 'simulated error' },
        failure: null,
      })
    ).toBe(false);
  });

  it('keeps a non-error indicator', () => {
    expect(
      statusIndicatorDuplicatesMessageFailure({
        indicator: { type: 'progress', message: 'Setting up environment…' },
        failure: assistantFailure(null),
      })
    ).toBe(false);
  });
});
