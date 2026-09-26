export const DEADLINE_MS = {
  startup: 2 * 60_000,
  socketHandshake: 10_000,
  wrapperReadiness: 90_000,
  heartbeatExpiry: 90_000,
  acceptedAlarmCap: 30_000,
  kiloInactivity: 7 * 60_000,
  idleStop: 10 * 60_000,
  stopAttempt: 30_000,
  stopAttemptLadder: [5_000, 10_000, 10_000, 10_000, 10_000] as const,
  reconciliation: 5 * 60_000,
  reconciliationWindow: 60 * 60_000,
  createSettle: 5 * 60_000,
  acceptedOverdue: 90_000,
  idleStopLeaseMargin: 60_000,
} as const;

export function leaseAtLeastMs(): number {
  return DEADLINE_MS.idleStop + DEADLINE_MS.idleStopLeaseMargin;
}
