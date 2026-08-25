import { describe, expect, it } from 'vitest';
import {
  PROMPT_FAILURE_LIMIT,
  failWaitingMessages,
  incrementPromptFailure,
  isPromptExhausted,
  nextQueuedMessageId,
} from '../session-message-queue.js';

describe('prompt exhausted', () => {
  it('fails the waiting queue after five prompt failures', () => {
    expect(PROMPT_FAILURE_LIMIT).toBe(5);
    let current = [{ messageId: 'a', state: 'queued' as const }];
    let failures = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = incrementPromptFailure(current, 'a');
      current = next.messages;
      failures = next.failures;
    }
    expect(failures).toBe(5);
    expect(isPromptExhausted(failures)).toBe(true);

    const { messages, failedIds } = failWaitingMessages(current, 'prompt_exhausted');
    expect(failedIds).toEqual(['a']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
