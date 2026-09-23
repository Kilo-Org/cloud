import { describe, expect, it } from 'vitest';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';
import { acceptedMessage, queuedMessage } from '../session-state.test-helpers.js';

describe('missing metadata', () => {
  it('fails the waiting queue when the session cannot succeed', () => {
    const { messages, failedIds } = failWaitingMessages(
      [queuedMessage('a'), acceptedMessage('b', { acceptedAt: 2 })],
      'missing_metadata'
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(
      messages.every(
        message => message.state.kind === 'failed' && message.state.reason === 'missing_metadata'
      )
    ).toBe(true);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
