import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { acceptedAlarmDecision } from '../accepted-overdue.js';
import { failWaitingMessages, nextQueuedMessageId } from '../session-message-queue.js';

describe('accepted overdue', () => {
  it('re-arms at the 30s cap and fails the waiting queue after 90s without activity', () => {
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

  it('keeps a continuously active turn accepted beyond the original 90s deadline', () => {
    const acceptedAt = 1_000;
    const lastActivityAt = acceptedAt + DEADLINE_MS.acceptedOverdue - 1;
    const originalDeadline = acceptedAt + DEADLINE_MS.acceptedOverdue;

    expect(acceptedAlarmDecision(acceptedAt, originalDeadline, lastActivityAt)).toEqual({
      action: 'rearm',
      at: lastActivityAt + DEADLINE_MS.acceptedOverdue,
    });
  });

  it('fails when silence reaches 90s after the most recent activity', () => {
    const acceptedAt = 1_000;
    const lastActivityAt = acceptedAt + DEADLINE_MS.acceptedOverdue;

    expect(
      acceptedAlarmDecision(
        acceptedAt,
        lastActivityAt + DEADLINE_MS.acceptedOverdue - 1,
        lastActivityAt
      )
    ).toEqual({ action: 'rearm', at: lastActivityAt + DEADLINE_MS.acceptedOverdue });
    expect(
      acceptedAlarmDecision(
        acceptedAt,
        lastActivityAt + DEADLINE_MS.acceptedOverdue,
        lastActivityAt
      )
    ).toEqual({ action: 'fail' });
  });
});
