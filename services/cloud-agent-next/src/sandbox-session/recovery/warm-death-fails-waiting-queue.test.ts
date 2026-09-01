import { describe, expect, it } from 'vitest';
import {
  claimCreate,
  confirmRunning,
  initialPhysicalRecord,
  observe,
} from '../../sandbox-control/physical-lifecycle.js';
import { controlDispatchDisposition } from '../control-dispatch.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('warm death', () => {
  it('fails the waiting queue when observe reports terminal', () => {
    const physical = observe(
      confirmRunning(claimCreate(initialPhysicalRecord(true), 'intent_1', 1_000), 'ref_1', 1_000),
      'terminal'
    );
    expect(physical.state).toBe('failed');
    const disposition = controlDispatchDisposition({
      physical: physical.state,
      connection: 'disconnected',
    });
    if (disposition.action !== 'fail') throw new Error('Expected a terminal disposition');
    const { reason } = disposition;
    const { messages, failedIds } = failWaitingMessages(
      [
        { messageId: 'a', state: 'accepted', acceptedAt: 5 },
        { messageId: 'b', state: 'queued' },
      ],
      reason
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
