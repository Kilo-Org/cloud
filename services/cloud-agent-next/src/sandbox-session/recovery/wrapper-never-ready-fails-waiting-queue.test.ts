import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { controlDispatchDisposition } from '../control-dispatch.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('wrapper never ready', () => {
  it('fails the waiting queue when wrapper-readiness expires', () => {
    expect(DEADLINE_MS.wrapperReadiness).toBe(90_000);
    const disposition = controlDispatchDisposition({
      physical: 'failed',
      connection: 'disconnected',
    });
    if (disposition.action !== 'fail') throw new Error('Expected a terminal disposition');
    const { reason } = disposition;
    const { failedIds, messages } = failWaitingMessages(
      [{ messageId: 'a', state: 'queued' }],
      reason
    );
    expect(failedIds).toEqual(['a']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
