import { describe, expect, it } from 'vitest';
import {
  PROMPT_FAILURE_LIMIT,
  failWaitingMessages,
  incrementDeliveryFailure,
  nextQueuedMessageId,
  type SessionMessageRecord,
} from '../session-message-queue.js';

describe('prompt exhausted', () => {
  it('fails the waiting queue after five prompt failures', () => {
    expect(PROMPT_FAILURE_LIMIT).toBe(5);
    let current: SessionMessageRecord[] = [{ messageId: 'a', state: 'queued', attachFailures: 1 }];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const next = incrementDeliveryFailure(current, 'a', 'prompt');
      current = next.messages;
      expect(next.exhausted).toBe(attempt === 5);
    }
    expect(current[0]).toMatchObject({ attachFailures: 1, promptFailures: 5 });

    const { messages, failedIds } = failWaitingMessages(current, 'prompt_exhausted');
    expect(failedIds).toEqual(['a']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
