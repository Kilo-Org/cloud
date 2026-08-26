import { DEADLINE_MS } from '../sandbox-control/deadlines.js';

export type AcceptedAlarmDecision = { action: 'fail' } | { action: 'rearm'; at: number };

export function acceptedAlarmDecision(
  acceptedAt: number,
  now: number,
  lastActivityAt?: number
): AcceptedAlarmDecision {
  const failAt = (lastActivityAt ?? acceptedAt) + DEADLINE_MS.acceptedOverdue;
  if (now >= failAt) return { action: 'fail' };
  return { action: 'rearm', at: failAt };
}
