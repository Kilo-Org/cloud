import { describe, expect, it, vi } from 'vitest';

import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import {
  countInFlightMessages,
  resolveRetryPrompt,
  retryFailedMessage,
} from './session-detail-content-helpers';
import { getSessionTranscriptItemKey, mergeSessionTranscript } from './session-transcript';
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

describe('retryFailedMessage', () => {
  it('re-sends the failed submission', async () => {
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await retryFailedMessage({
      message: userMessage('m1'),
      send,
      clearFailedMessage,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clears the original delivery failure once the re-send is accepted', async () => {
    const message = userMessage('m-failed');
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await retryFailedMessage({ message, send, clearFailedMessage });
    expect(clearFailedMessage).toHaveBeenCalledExactlyOnceWith('m-failed');
  });

  it('leaves the failed delivery state alone when the re-send rejects', async () => {
    const message = userMessage('m-failed');
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await expect(
      retryFailedMessage({ message, send, clearFailedMessage })
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailedMessage).not.toHaveBeenCalled();
  });

  it('does not clear an assistant failure row, which stays marked', async () => {
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await retryFailedMessage({
      message: assistantMessage('m-asst'),
      send,
      clearFailedMessage,
    });
    expect(clearFailedMessage).not.toHaveBeenCalled();
  });

  it('swallows a rejected re-send so the caller never sees the rejection', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await expect(
      retryFailedMessage({ message: userMessage('m1'), send, clearFailedMessage })
    ).resolves.toBeUndefined();
  });

  it('stops the delivery failure showing in the transcript once the retry lands', async () => {
    // A client-materialised submission with no renderable parts appears at all
    // only because its run failed; clearing the entry drops it, and no row
    // keeps a failure footer.
    const submission = userMessage('m-retried');
    submission.parts = [];
    (submission.info as { synthetic?: boolean }).synthetic = true;
    const deliveryStates = new Map<string, MessageDeliveryState>([
      ['m-retried', { status: 'failed', error: 'boom', reason: 'execution' }],
    ]);

    expect(
      mergeSessionTranscript([submission], [], deliveryStates).map(item =>
        getSessionTranscriptItemKey(item)
      )
    ).toEqual(['time:m-retried', 'm-retried']);

    await retryFailedMessage({
      message: submission,
      send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      clearFailedMessage: messageId => {
        deliveryStates.delete(messageId);
      },
    });

    expect(deliveryStates.has('m-retried')).toBe(false);
    expect(mergeSessionTranscript([submission], [], deliveryStates)).toEqual([]);
  });

  it('keeps the failure showing when the re-send itself fails', async () => {
    const submission = userMessage('m-kept');
    const deliveryStates = new Map<string, MessageDeliveryState>([
      ['m-kept', { status: 'failed', error: 'boom', reason: 'execution' }],
    ]);

    await retryFailedMessage({
      message: submission,
      send: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Failed to send message')),
      clearFailedMessage: messageId => {
        deliveryStates.delete(messageId);
      },
    });

    expect(deliveryStates.get('m-kept')).toEqual({
      status: 'failed',
      error: 'boom',
      reason: 'execution',
    });
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
