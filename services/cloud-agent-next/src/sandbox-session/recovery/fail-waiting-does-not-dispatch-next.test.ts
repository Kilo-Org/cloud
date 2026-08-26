import { describe, expect, it } from 'vitest';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('failWaitingMessages', () => {
  it('does not leave a next id to dispatch', () => {
    const before = [
      { messageId: 'head', state: 'queued' as const },
      { messageId: 'next', state: 'queued' as const },
    ];
    expect(nextQueuedMessageId(before)).toBe('head');
    const { messages, failedIds } = failWaitingMessages(before, 'environment_failed');
    expect(failedIds).toEqual(['head', 'next']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
    expect(messages.some(message => message.state === 'queued')).toBe(false);
    expect(messages.some(message => message.state === 'accepted')).toBe(false);
  });
});
