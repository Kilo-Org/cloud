import { describe, expect, it } from 'vitest';
import {
  ATTACH_FAILURE_LIMIT,
  failWaitingMessages,
  incrementDeliveryFailure,
  nextQueuedMessageId,
  type SessionMessageRecord,
} from '../session-message-queue.js';

describe('attach exhausted', () => {
  it('fails the waiting queue after two attach failures', () => {
    expect(ATTACH_FAILURE_LIMIT).toBe(2);
    const current: SessionMessageRecord[] = [
      { messageId: 'a', state: 'queued', promptFailures: 2 },
      { messageId: 'b', state: 'queued' },
    ];
    const first = incrementDeliveryFailure(current, 'a', 'attach');
    expect(first.exhausted).toBe(false);
    const second = incrementDeliveryFailure(first.messages, 'a', 'attach');
    expect(second.exhausted).toBe(true);
    expect(second.messages[0]).toMatchObject({ attachFailures: 2, promptFailures: 2 });

    const { messages, failedIds } = failWaitingMessages(second.messages, 'attach_exhausted');
    expect(failedIds).toEqual(['a', 'b']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
