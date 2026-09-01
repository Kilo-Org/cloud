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

  it('keeps accepted work alive when meaningful activity occurs after admission', () => {
    const acceptedAt = 1_000;
    const activityAt = acceptedAt + 80_000;
    const now = acceptedAt + 120_000;

    expect(acceptedAlarmDecision(acceptedAt, now, activityAt)).toEqual({
      action: 'rearm',
      at: now + DEADLINE_MS.acceptedAlarmCap,
    });
    expect(
      acceptedAlarmDecision(acceptedAt, activityAt + DEADLINE_MS.acceptedOverdue, activityAt)
    ).toEqual({ action: 'check' });
  });

  it('never moves the accepted deadline backwards for older activity timestamps', () => {
    const acceptedAt = 10_000;
    const now = acceptedAt + DEADLINE_MS.acceptedOverdue - 1_000;

    expect(acceptedAlarmDecision(acceptedAt, now, acceptedAt - 5_000)).toEqual({
      action: 'rearm',
      at: acceptedAt + DEADLINE_MS.acceptedOverdue,
    });
  });
});
