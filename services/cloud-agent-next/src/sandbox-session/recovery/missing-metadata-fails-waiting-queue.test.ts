import { describe, expect, it } from 'vitest';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('missing metadata', () => {
  it('fails the waiting queue when the session cannot succeed', () => {
    const { messages, failedIds } = failWaitingMessages(
      [
        { messageId: 'a', state: 'queued' },
        { messageId: 'b', state: 'accepted', acceptedAt: 2 },
      ],
      'missing_metadata'
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(messages.every(message => message.failedReason === 'missing_metadata')).toBe(true);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
