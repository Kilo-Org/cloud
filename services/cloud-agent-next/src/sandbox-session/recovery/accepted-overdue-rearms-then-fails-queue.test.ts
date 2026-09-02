import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { acceptedAlarmDecision } from '../accepted-overdue.js';

describe('accepted watchdog scheduling', () => {
  it('caps every accepted wakeup at 30 seconds', () => {
    const acceptedAt = 1_000;
    const now = acceptedAt + DEADLINE_MS.acceptedAlarmCap;
    expect(acceptedAlarmDecision(acceptedAt, now)).toEqual({
      action: 'rearm',
      at: now + DEADLINE_MS.acceptedAlarmCap,
    });
  });

  it('requires a health check, not terminal failure, after content silence', () => {
    const acceptedAt = 1_000;
    expect(acceptedAlarmDecision(acceptedAt, acceptedAt + DEADLINE_MS.acceptedOverdue)).toEqual({
      action: 'check',
    });
  });

  it('uses fresh activity while keeping the durable alarm cap', () => {
    const acceptedAt = 1_000;
    const now = acceptedAt + DEADLINE_MS.acceptedOverdue;
    expect(acceptedAlarmDecision(acceptedAt, now, now - 1)).toEqual({
      action: 'rearm',
      at: now + DEADLINE_MS.acceptedAlarmCap,
    });
    expect(acceptedAlarmDecision(acceptedAt, now + DEADLINE_MS.acceptedOverdue, now)).toEqual({
      action: 'check',
    });
  });
});
