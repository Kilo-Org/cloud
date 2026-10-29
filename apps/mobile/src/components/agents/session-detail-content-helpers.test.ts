import { describe, expect, it, vi } from 'vitest';

import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import {
  countInFlightMessages,
  resolveRetryPrompt,
  resolveRetryTarget,
  retryFailedMessage,
} from './session-detail-content-helpers';
import { getSessionTranscriptItemKey, mergeSessionTranscript } from './session-transcript';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

/** The assistant row that answers `parentID`, as server data links them. */
function withParent(message: StoredMessage, parentID: string): StoredMessage {
  if (message.info.role !== 'assistant') {
    return message;
  }
  return { ...message, info: { ...message.info, parentID } };
}

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
  it('clears the original delivery failure once the re-send is accepted', async () => {
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await retryFailedMessage({ replacedMessageIds: ['m-failed'], send, clearFailedMessage });
    expect(clearFailedMessage).toHaveBeenCalledExactlyOnceWith('m-failed');
  });

  it('leaves the failed delivery state alone when the re-send rejects', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await expect(
      retryFailedMessage({ replacedMessageIds: ['m-failed'], send, clearFailedMessage })
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailedMessage).not.toHaveBeenCalled();
  });

  it('resolves every row an assistant retry replaces once the re-send is accepted', async () => {
    // The retried turn's own user row carries the prompt; the failed response
    // and the user row it re-sent both stop showing.
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await retryFailedMessage({
      replacedMessageIds: ['m-asst', 'm-prompt'],
      send,
      clearFailedMessage,
    });
    expect(clearFailedMessage.mock.calls).toEqual([['m-asst'], ['m-prompt']]);
  });

  it('swallows a rejected re-send so the caller never sees the rejection', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailedMessage = vi.fn<(messageId: string) => void>();
    await expect(
      retryFailedMessage({ replacedMessageIds: ['m1'], send, clearFailedMessage })
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

    // The marker folds onto the message row as `timeMarker`, so the failed
    // submission is the only item and its key no longer carries a `time:` row.
    expect(
      mergeSessionTranscript([submission], [], { deliveryStates }).map(item =>
        getSessionTranscriptItemKey(item)
      )
    ).toEqual(['m-retried']);

    await retryFailedMessage({
      replacedMessageIds: [submission.info.id],
      send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      clearFailedMessage: messageId => {
        deliveryStates.delete(messageId);
      },
    });

    expect(deliveryStates.has('m-retried')).toBe(false);
    expect(mergeSessionTranscript([submission], [], { deliveryStates })).toEqual([]);
  });

  it('keeps the failure showing when the re-send itself fails', async () => {
    const submission = userMessage('m-kept');
    const deliveryStates = new Map<string, MessageDeliveryState>([
      ['m-kept', { status: 'failed', error: 'boom', reason: 'execution' }],
    ]);

    await retryFailedMessage({
      replacedMessageIds: [submission.info.id],
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

describe('resolveRetryTarget', () => {
  it('replaces only a failed user row', () => {
    const message = userMessage('m1');
    expect(resolveRetryTarget(message, [message])).toEqual({
      prompt: 'hi',
      replacedMessageIds: ['m1'],
    });
  });

  it('replaces the failed response and the user row it re-sends', () => {
    const user = userMessage('m3');
    const assistant = withParent(assistantMessage('m4'), 'm3');

    expect(resolveRetryTarget(assistant, [user, assistant])).toEqual({
      prompt: 'hi',
      replacedMessageIds: ['m4', 'm3'],
    });
  });

  it('re-sends the row the failed response answers, not the nearest preceding row', () => {
    // A second prompt can be materialised before the first turn's response
    // exists, so order alone would re-send (and hide) the wrong prompt.
    const answered = userMessage('m-answered');
    const queued = userMessage('m-queued');
    const assistant = withParent(assistantMessage('m-asst'), 'm-answered');

    expect(resolveRetryTarget(assistant, [answered, queued, assistant])).toEqual({
      prompt: 'hi',
      replacedMessageIds: ['m-asst', 'm-answered'],
    });
  });

  it('keeps a prompt row that carries content the re-send would drop', () => {
    const user = userMessage('m-with-file');
    user.parts = [
      ...user.parts,
      {
        id: 'm-with-file-file',
        sessionID: 'ses_1',
        messageID: 'm-with-file',
        type: 'file',
        mime: 'text/plain',
        url: 'x',
      },
    ] as typeof user.parts;
    const assistant = withParent(assistantMessage('m-asst'), 'm-with-file');

    expect(resolveRetryTarget(assistant, [user, assistant])).toEqual({
      prompt: 'hi',
      replacedMessageIds: ['m-asst'],
    });
  });

  it('returns null when no user row can be identified as the prompt', () => {
    const assistant = assistantMessage('m5');
    expect(resolveRetryTarget(assistant, [assistant])).toBeNull();
    // Order alone must not pair the response with an unrelated later prompt.
    const other = userMessage('m-other');
    expect(resolveRetryTarget(withParent(assistant, 'm-missing'), [other, assistant])).toBeNull();
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

  it('resolves the prompt through the same target the tap uses', () => {
    const user = userMessage('m3');
    const assistant = withParent(assistantMessage('m4'), 'm3');
    expect(resolveRetryPrompt(assistant, [user, assistant])).toBe('hi');
    expect(resolveRetryPrompt(withParent(assistantMessage('m6'), 'm-missing'), [user])).toBeNull();
  });
});
