import { describe, expect, it } from 'vitest';
import { failureReasonFromControlStatus } from '../control-dispatch.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('create() throws', () => {
  it('fails every queued and accepted message', () => {
    const reason = failureReasonFromControlStatus('failed');
    expect(reason).toBe('environment_failed');
    const { messages, failedIds } = failWaitingMessages(
      [
        { messageId: 'a', state: 'queued', prompt: 'one' },
        { messageId: 'b', state: 'accepted', acceptedAt: 10, prompt: 'two' },
        { messageId: 'c', state: 'completed' },
      ],
      reason ?? 'environment_failed'
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(
      messages.map(message => [message.messageId, message.state, message.failedReason])
    ).toEqual([
      ['a', 'failed', 'environment_failed'],
      ['b', 'failed', 'environment_failed'],
      ['c', 'completed', undefined],
    ]);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
