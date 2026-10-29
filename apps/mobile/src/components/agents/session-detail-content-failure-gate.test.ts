import { describe, expect, it } from 'vitest';

import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { lastVisibleMessageFailure } from './session-detail-content-helpers';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

/** The assistant row that answers `parentID`, as server data links them. */
function withParent(message: StoredMessage, parentID: string): StoredMessage {
  if (message.info.role !== 'assistant') {
    return message;
  }
  return { ...message, info: { ...message.info, parentID } };
}

describe('lastVisibleMessageFailure', () => {
  function assistantMessageWithText(id: string): StoredMessage {
    const message = assistantMessage(id);
    message.parts = [
      { id: `${id}-text`, sessionID: 'ses_1', messageID: id, type: 'text', text: 'reply' },
    ] as typeof message.parts;
    return message;
  }

  function assistantMessageWithError(id: string, errorName: string): StoredMessage {
    const message = assistantMessageWithText(id);
    (message.info as { error?: { name: string; data: unknown } }).error = {
      name: errorName,
      data: { message: 'raw' },
    };
    return message;
  }

  const noPending = new Map<string, MessageDeliveryState>();
  const nothingCanceled = new Map<string, StoredMessage>();

  it('returns null when the last row has no failure', () => {
    const messages: StoredMessage[] = [userMessage('m1'), assistantMessageWithText('m2')];
    expect(
      lastVisibleMessageFailure({
        displayedMessages: messages,
        messages,
        pendingMessages: noPending,
        canceledQueuedMessages: nothingCanceled,
      })
    ).toBeNull();
  });

  it('returns the assistant failure the last row renders with a Retry', () => {
    const messages: StoredMessage[] = [
      userMessage('m1'),
      withParent(assistantMessageWithError('m2', 'APIError'), 'm1'),
    ];
    const failure = lastVisibleMessageFailure({
      displayedMessages: messages,
      messages,
      pendingMessages: noPending,
      canceledQueuedMessages: nothingCanceled,
    });
    expect(failure?.kind).toBe('assistant');
    expect(failure?.title).toBe('Response failed');
    expect(failure?.detailKey).toBe('agentChat.messageFailure.assistantProviderError');
  });

  it('returns null for an assistant failure with no preceding user row (no Retry)', () => {
    const messages: StoredMessage[] = [assistantMessageWithError('m1', 'APIError')];
    expect(
      lastVisibleMessageFailure({
        displayedMessages: messages,
        messages,
        pendingMessages: noPending,
        canceledQueuedMessages: nothingCanceled,
      })
    ).toBeNull();
  });

  it('returns the delivery failure the last row renders', () => {
    const messages: StoredMessage[] = [userMessage('m1')];
    const pendingMessages = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'failed', error: 'nope', reason: 'exhausted' }],
    ]);
    const failure = lastVisibleMessageFailure({
      displayedMessages: messages,
      messages,
      pendingMessages,
      canceledQueuedMessages: nothingCanceled,
    });
    expect(failure?.kind).toBe('delivery');
    expect(failure?.title).toBe('Failed to deliver');
  });

  it('ignores a cancelled queued row', () => {
    const messages: StoredMessage[] = [userMessage('m1')];
    const pendingMessages = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'failed', error: 'nope', reason: 'exhausted' }],
    ]);
    expect(
      lastVisibleMessageFailure({
        displayedMessages: messages,
        messages,
        pendingMessages,
        canceledQueuedMessages: new Map<string, StoredMessage>([['m1', userMessage('m1')]]),
      })
    ).toBeNull();
  });

  it('ignores a failure that is not the last row', () => {
    const messages: StoredMessage[] = [
      userMessage('m1'),
      assistantMessageWithError('m2', 'APIError'),
      assistantMessageWithText('m3'),
    ];
    expect(
      lastVisibleMessageFailure({
        displayedMessages: messages,
        messages,
        pendingMessages: noPending,
        canceledQueuedMessages: nothingCanceled,
      })
    ).toBeNull();
  });
});
