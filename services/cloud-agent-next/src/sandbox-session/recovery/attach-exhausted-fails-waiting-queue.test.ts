import { describe, expect, it } from 'vitest';
import {
  ATTACH_FAILURE_LIMIT,
  failWaitingMessages,
  incrementAttachFailure,
  isAttachExhausted,
  nextQueuedMessageId,
  type SessionMessageRecord,
} from '../session-message-queue.js';

describe('attach exhausted', () => {
  it('fails the waiting queue after two attach failures', () => {
    expect(ATTACH_FAILURE_LIMIT).toBe(2);
    let current: SessionMessageRecord[] = [
      { messageId: 'a', state: 'queued' },
      { messageId: 'b', state: 'queued' },
    ];
    const first = incrementAttachFailure(current, 'a');
    expect(isAttachExhausted(first.failures)).toBe(false);
    current = first.messages;
    const second = incrementAttachFailure(current, 'a');
    expect(isAttachExhausted(second.failures)).toBe(true);

    const { messages, failedIds } = failWaitingMessages(second.messages, 'attach_exhausted');
    expect(failedIds).toEqual(['a', 'b']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
