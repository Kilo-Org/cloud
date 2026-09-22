import { DEADLINE_MS } from '../sandbox-control/deadlines.js';

export type AcceptedAlarmDecision = { action: 'check' } | { action: 'rearm'; at: number };

export function acceptedAlarmDecision(
  acceptedAt: number,
  now: number,
  lastActivityAt?: number
): AcceptedAlarmDecision {
  const checkAt = (lastActivityAt ?? acceptedAt) + DEADLINE_MS.acceptedOverdue;
  if (now >= checkAt) return { action: 'check' };
  return { action: 'rearm', at: Math.min(checkAt, now + DEADLINE_MS.acceptedAlarmCap) };
}

/**
 * The inactivity bound. `activityAt` is `lastActivityAt ?? acceptedAt`; callers
 * must not substitute `0` for a missing accepted-at, because that would fail a
 * turn that was never accepted.
 */
export function acceptedInactivityDue(activityAt: number, now: number): boolean {
  return now >= activityAt + DEADLINE_MS.kiloInactivity;
}
