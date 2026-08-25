import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { acceptedAlarmDecision } from '../accepted-overdue.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('accepted overdue', () => {
  it('re-arms at the 30s cap and fails the waiting queue at 90s', () => {
    const acceptedAt = 1_000;
    const rearm = acceptedAlarmDecision(acceptedAt, acceptedAt + DEADLINE_MS.acceptedAlarmCap);
    expect(rearm).toEqual({ action: 'rearm', at: acceptedAt + DEADLINE_MS.acceptedOverdue });

    const overdue = acceptedAlarmDecision(acceptedAt, acceptedAt + DEADLINE_MS.acceptedOverdue);
    expect(overdue).toEqual({ action: 'fail' });

    const { messages, failedIds } = failWaitingMessages(
      [
        { messageId: 'a', state: 'accepted', acceptedAt },
        { messageId: 'b', state: 'queued' },
      ],
      'accepted_overdue'
    );
    expect(failedIds).toEqual(['a', 'b']);
    expect(nextQueuedMessageId(messages)).toBeUndefined();
  });
});
