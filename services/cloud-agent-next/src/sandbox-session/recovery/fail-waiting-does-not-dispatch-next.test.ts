import { describe, expect, it } from 'vitest';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';
import { queuedMessage } from '../session-state.test-helpers.js';

describe('failWaitingMessages', () => {
  it('does not leave a next id to dispatch', () => {
    const before = [queuedMessage('head'), queuedMessage('next')];
    expect(nextQueuedMessageId(before)).toBe('head');
    const { messages, failedIds } = failWaitingMessages(before, 'environment_failed');
    expect(failedIds).toEqual(['head', 'next']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
    expect(messages.some(message => message.state.kind === 'queued')).toBe(false);
    expect(messages.some(message => message.state.kind === 'accepted')).toBe(false);
    expect(messages.every(message => message.state.kind === 'failed')).toBe(true);
  });
});
