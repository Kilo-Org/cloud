/* eslint-disable max-lines -- one suite pins every terminal class's copy, retryability, and code mapping. */
import { describe, expect, it } from 'vitest';

import { type SdkStatusMessageCode } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import { type MessageFailure } from './message-failure-state';
import {
  buildTerminalErrorCopyText,
  classifyTerminalError,
  describeSessionRuntimeFailure,
  describeTerminalFailure,
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

describe('describeTerminalFailure', () => {
  // One case per class. Each raw string is what the session manager's
  // `formatError` (or the Durable Object's projection) writes into the child
  // sheet's hydration state and error atom, so the sheet renders catalog copy
  // and a Retry only where one can help.
  it.each([
    {
      message: 'Connection lost. Please retry in a moment.',
      variant: 'server',
      key: 'agentChat.session.connectionTrouble',
      retryable: true,
    },
    {
      message: 'Service is unavailable right now. Please try again.',
      variant: 'server',
      key: 'agentChat.session.serviceUnavailable',
      retryable: true,
    },
    {
      message: 'Previous task is still finishing up. Please wait a moment.',
      variant: 'server',
      key: 'agentChat.session.previousTaskFinishing',
      retryable: true,
    },
    {
      message: 'This session is no longer available.',
      variant: 'not-found',
      key: 'queryError.notFoundDescription',
      retryable: false,
    },
    {
      message: 'You are not authorized to use the Cloud Agent.',
      variant: 'permission',
      key: 'queryError.permissionDescription',
      retryable: false,
    },
    {
      message: 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
      variant: 'server',
      key: 'agentChat.session.notEnoughCredits',
      retryable: false,
    },
    {
      message: 'Selected model is unavailable for Cloud Agent.',
      variant: 'server',
      key: 'agentChat.session.modelUnavailable',
      retryable: false,
    },
    {
      message: 'some unexpected failure',
      variant: 'server',
      key: 'agentChat.session.failedToLoadDetails',
      retryable: false,
    },
  ] as const)('describes $message', ({ message, variant, key, retryable }) => {
    expect(describeTerminalFailure(message)).toEqual({
      variant,
      message: i18n.t(key),
      retryable,
      detail: message,
      title: expect.any(String),
    });
  });

  it('keeps the untranslated original in detail', () => {
    const raw = 'Connection lost. Please retry in a moment.';
    expect(describeTerminalFailure(raw).detail).toBe(raw);
  });
});

describe('describeSessionRuntimeFailure', () => {
  // The child sheet's `sessionError` is a failed agent run, not a failed page
  // load: every copy here must match what the sheet's transcript banner shows
  // for the same value through `sessionStatusErrorMessage`.
  it.each([
    ['Runtime failure', 'agentChat.messageFailure.assistantFailed'],
    ['This session is no longer available.', 'queryError.notFoundDescription'],
    ['Connection lost. Please retry in a moment.', 'agentChat.session.connectionTrouble'],
  ] as const)('describes %s', (message, key) => {
    expect(describeSessionRuntimeFailure(message)).toEqual({
      message: i18n.t(key),
      detail: message,
    });
  });

  it('never names a page-load failure for an unrecognized runtime error', () => {
    expect(describeSessionRuntimeFailure('Runtime failure').message).not.toBe(
      i18n.t('agentChat.session.failedToLoadDetails')
    );
  });

  it('passes the Durable Object safety projection through unchanged', () => {
    const raw = 'Assistant request failed: model not found';
    expect(describeSessionRuntimeFailure(raw)).toEqual({ message: raw, detail: raw });
  });
});

const indicatorFor = (message: string) => ({
  error: null,
  statusIndicator: { type: 'error' as const, message },
  messageCount: 0,
});

const codedIndicatorFor = (message: string, code: SdkStatusMessageCode) => ({
  error: null,
  statusIndicator: { type: 'error' as const, message, code },
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

  // The code names the failure on its own; the transport's English detail still
  // reaches Copy untouched.
  it('classifies a coded disconnect as retryable and preserves the detail', () => {
    expect(
      resolveSessionTerminalError(
        codedIndicatorFor('Connection lost. Please retry in a moment.', 'connection-lost')
      )
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'Connection trouble. Please retry in a moment.',
      retryable: true,
      detail: 'Connection lost. Please retry in a moment.',
    });
  });

  it('classifies a coded session termination as non-retryable', () => {
    expect(
      resolveSessionTerminalError(codedIndicatorFor('Session terminated', 'session-terminated'))
    ).toEqual({
      variant: 'server',
      title: "Couldn't load this session",
      message: 'Failed to load session details',
      retryable: false,
      detail: 'Session terminated',
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
    expect(sessionStatusErrorMessage({ message: raw })).toBe(expected);
  });

  // The SDK codes the fixed copy it writes itself, so the app renders its own
  // catalog line for the code instead of the SDK's English message. Every code
  // is covered so a new code cannot silently lose its copy.
  it.each([
    ['agent-connection-lost', 'Agent connection lost', 'Connection lost'],
    ['session-stopped', 'Session stopped', 'Session stopped'],
    ['session-terminated', 'Session terminated', 'The response failed.'],
    ['failed-to-stop-execution', 'Failed to stop execution', 'Failed to stop execution'],
    ['message-delivery-failed', 'Message failed to deliver', 'Failed to deliver'],
    ['commit-failed', 'Commit failed', 'Commit failed'],
    [
      'not-authorized',
      'You are not authorized to use the Cloud Agent.',
      "You don't have permission to view this.",
    ],
    [
      'insufficient-credits',
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
      'Not enough credits to run Cloud Agent. Add credits and try again.',
    ],
    [
      'previous-task-in-progress',
      'Previous task is still finishing up. Please wait a moment.',
      'The previous task is still finishing. Please wait a moment.',
    ],
    [
      'selected-model-unavailable',
      'Selected model is unavailable for Cloud Agent.',
      "This model isn't available for Cloud Agent. Choose another model and try again.",
    ],
    [
      'service-unavailable',
      'Service is unavailable right now.',
      'The service is unavailable right now. Please try again.',
    ],
    [
      'service-temporarily-unavailable',
      'Service is temporarily unavailable.',
      'The service is unavailable right now. Please try again.',
    ],
    ['connection-lost', 'Connection lost.', 'Connection trouble. Please retry in a moment.'],
    ['connection-failed', 'Connection failed.', 'Connection trouble. Please retry in a moment.'],
    ['generic-error', 'Something went wrong.', 'Connection trouble. Please retry in a moment.'],
    [
      'child-session-not-found',
      'This session is no longer available.',
      'This item may have been removed or is no longer available.',
    ],
  ] as const)('renders catalog copy for the %s code', (code, message, expected) => {
    expect(sessionStatusErrorMessage({ message, code })).toBe(expected);
  });

  // A message the SDK forwards without a code keeps the classifier's answer:
  // the same strings the SDK used to write itself are no longer special-cased.
  it.each([
    ['Agent connection lost', 'The response failed.'],
    ['Session terminated', 'The response failed.'],
    ['Failed to stop execution', 'The response failed.'],
    ['Message failed to deliver', 'Failed to deliver'],
  ] as const)('keeps the code-less fallback for %s', (raw, expected) => {
    expect(sessionStatusErrorMessage({ message: raw })).toBe(expected);
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
    expect(sessionStatusErrorMessage({ message: raw })).toBe(raw);
  });

  it('never returns the raw provider text', () => {
    const raw = 'Service Unavailable: The service is temporarily unavailable.';
    expect(sessionStatusErrorMessage({ message: raw })).not.toContain('Service Unavailable');
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
