import { DEADLINE_MS } from '../sandbox-control/deadlines.js';

export type AcceptedAlarmDecision = { action: 'check' } | { action: 'rearm'; at: number };

export function acceptedAlarmDecision(
  acceptedAt: number,
  now: number,
  lastActivityAt = acceptedAt
): AcceptedAlarmDecision {
  const checkAt = Math.max(acceptedAt, lastActivityAt) + DEADLINE_MS.acceptedOverdue;
  if (now >= checkAt) return { action: 'check' };
  return { action: 'rearm', at: Math.min(checkAt, now + DEADLINE_MS.acceptedAlarmCap) };
}
