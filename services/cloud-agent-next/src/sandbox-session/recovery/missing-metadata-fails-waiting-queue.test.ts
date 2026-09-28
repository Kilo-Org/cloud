import { describe, expect, it } from 'vitest';
import {
  failWaitingMessages,
  failedMessageSnapshot,
  failedReasonOf,
  nextQueuedMessageId,
} from '../session-message-queue.js';
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

  it('settles a cancellation-bearing row as interrupted while the rest fail closed', () => {
    const { messages, failedIds } = failWaitingMessages(
      [
        queuedMessage('a'),
        acceptedMessage('b', { acceptedAt: 2 }),
        acceptedMessage(
          'c',
          { acceptedAt: 3 },
          { cancellation: { operationId: 'op', deadlineAt: 30 } }
        ),
      ],
      'missing_metadata'
    );
    expect(failedIds).toEqual(['a', 'b', 'c']);
    expect(messages[0]?.state).toMatchObject({ kind: 'failed', reason: 'missing_metadata' });
    expect(messages[1]?.state).toMatchObject({ kind: 'failed', reason: 'missing_metadata' });
    expect(messages[2]?.state.kind).toBe('cancelled');
    expect(failedReasonOf(messages[2]!)).toBeUndefined();
    expect(failedMessageSnapshot(messages[2]!, 99)).toMatchObject({
      status: 'interrupted',
      reason: 'interrupted',
      delivery: 'sent',
      accepted: true,
      error: 'The message was interrupted',
    });
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
