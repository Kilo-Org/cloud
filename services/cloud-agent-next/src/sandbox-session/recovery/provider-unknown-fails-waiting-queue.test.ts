import { describe, expect, it } from 'vitest';
import { nextEnsureReadyStep } from '../../sandbox-control/ensure-ready.js';
import { controlDispatchDisposition } from '../control-dispatch.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('provider unknown', () => {
  it('fails the waiting queue and does not create a replacement', () => {
    expect(nextEnsureReadyStep('unknown', true)).toBe('observe-unknown');
    expect(nextEnsureReadyStep('unknown', false)).toBe('observe-unknown');
    const disposition = controlDispatchDisposition({
      physical: 'unknown',
      connection: 'disconnected',
    });
    if (disposition.action !== 'fail') throw new Error('Expected a terminal disposition');
    const { reason } = disposition;
    expect(reason).toBe('provider_unknown');
    const { messages, failedIds } = failWaitingMessages(
      [
        { messageId: 'a', state: 'queued' },
        { messageId: 'b', state: 'accepted', acceptedAt: 1 },
      ],
      reason
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(messages.map(message => message.failedReason)).toEqual([
      'provider_unknown',
      'provider_unknown',
    ]);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
