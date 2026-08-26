import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { failureReasonFromControlStatus } from '../control-dispatch.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('startup timeout', () => {
  it('fails the waiting queue after the two-minute startup deadline', () => {
    expect(DEADLINE_MS.startup).toBe(2 * 60_000);
    const reason = failureReasonFromControlStatus('failed') ?? 'environment_failed';
    const { messages, failedIds } = failWaitingMessages(
      [
        { messageId: 'a', state: 'queued' },
        { messageId: 'b', state: 'queued' },
      ],
      reason
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(messages.every(message => message.state === 'failed')).toBe(true);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
