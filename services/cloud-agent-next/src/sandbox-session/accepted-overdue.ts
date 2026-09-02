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
