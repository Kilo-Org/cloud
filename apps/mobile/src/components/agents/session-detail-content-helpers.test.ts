import { describe, expect, it, vi } from 'vitest';

import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import {
  countInFlightMessages,
  resolveRetryPrompt,
  retryMessageAndClear,
  runConnectRepository,
} from './session-detail-content-helpers';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

describe('countInFlightMessages', () => {
  it('excludes a failed pending row from the in-flight count', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'failed', error: 'nope', reason: 'exhausted' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(1);
  });

  it('returns zero when every pending row failed', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'failed', error: 'nope', reason: 'interrupted' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(0);
  });

  it('counts every queued row', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'queued' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(2);
  });
});

describe('retryMessageAndClear', () => {
  it('clears the failed row when the retry send succeeds', async () => {
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailed = vi.fn<() => void>();
    await retryMessageAndClear(send, clearFailed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailed).toHaveBeenCalledTimes(1);
  });

  it('does not clear the failed row when the retry send fails', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailed = vi.fn<() => void>();
    await retryMessageAndClear(send, clearFailed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailed).not.toHaveBeenCalled();
  });
});

describe('runConnectRepository', () => {
  it('opens the GitHub integration and clears terminal guidance in order', () => {
    const openGitHubIntegration = vi.fn<() => void>();
    const clearGuidance = vi.fn<() => void>();

    runConnectRepository(openGitHubIntegration, clearGuidance);

    expect(openGitHubIntegration).toHaveBeenCalledTimes(1);
    expect(clearGuidance).toHaveBeenCalledTimes(1);
    expect(openGitHubIntegration.mock.invocationCallOrder[0]).toBeLessThan(
      clearGuidance.mock.invocationCallOrder[0] as number
    );
  });
});

describe('resolveRetryPrompt', () => {
  it('returns only the first human text part for a user row with a synthetic notice', () => {
    const message = userMessage('m1');
    message.parts = [
      {
        id: 'm1-prompt',
        sessionID: 'ses_1',
        messageID: 'm1',
        type: 'text',
        text: 'prompt',
      },
      {
        id: 'm1-notice',
        sessionID: 'ses_1',
        messageID: 'm1',
        type: 'text',
        text: 'binary attachment saved: … path=…',
        synthetic: true,
      },
    ] as typeof message.parts;

    expect(resolveRetryPrompt(message, [message])).toBe('prompt');
  });

  it('returns the synthetic queued prompt text for a user row whose only text part is synthetic', () => {
    const message = userMessage('m1b');
    message.parts = [
      {
        id: 'm1b-prompt',
        sessionID: 'ses_1',
        messageID: 'm1b',
        type: 'text',
        text: 'prompt',
        synthetic: true,
      },
    ] as typeof message.parts;

    expect(resolveRetryPrompt(message, [message])).toBe('prompt');
  });

  it('returns null for a file-only user row', () => {
    const message = userMessage('m2');
    message.parts = [
      {
        id: 'm2-file',
        sessionID: 'ses_1',
        messageID: 'm2',
        type: 'file',
        mime: 'text/plain',
        url: 'x',
      },
    ] as typeof message.parts;

    expect(resolveRetryPrompt(message, [message])).toBeNull();
  });

  it('returns the preceding user row human text for an assistant failure', () => {
    const user = userMessage('m3');
    const assistant = assistantMessage('m4');
    const messages: StoredMessage[] = [user, assistant];

    expect(resolveRetryPrompt(assistant, messages)).toBe('hi');
  });

  it('returns null for an assistant row with no preceding user row', () => {
    const assistant = assistantMessage('m5');
    expect(resolveRetryPrompt(assistant, [assistant])).toBeNull();
  });
});
