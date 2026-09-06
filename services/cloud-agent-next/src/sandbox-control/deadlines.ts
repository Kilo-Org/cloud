export const DEADLINE_IDS = [
  'startup',
  'socketHandshake',
  'wrapperReadiness',
  'heartbeatExpiry',
  'acceptedAlarmCap',
  'idleStop',
  'stopAttempt',
  'reconciliation',
  'credentialExpiry',
  'nativeRetirement',
] as const;
export type DeadlineId = (typeof DEADLINE_IDS)[number];

export type DeadlineTable = Partial<Record<DeadlineId, number>>;

export const DEADLINE_MS = {
  startup: 2 * 60_000,
  socketHandshake: 10_000,
  wrapperReadiness: 90_000,
  heartbeatExpiry: 90_000,
  acceptedAlarmCap: 30_000,
  idleStop: 5 * 60_000,
  stopAttempt: 30_000,
  stopAttemptLadder: [5_000, 10_000, 10_000, 10_000, 10_000] as const,
  reconciliation: 5 * 60_000,
  reconciliationWindow: 60 * 60_000,
  createSettle: 5 * 60_000,
  acceptedOverdue: 90_000,
  idleStopLeaseMargin: 60_000,
  nativeRetirementRetry: 1_000,
  nativeRetirementMaxAttempts: 5,
} as const;

export function leaseAtLeastMs(): number {
  return DEADLINE_MS.idleStop + DEADLINE_MS.idleStopLeaseMargin;
}

export function emptyDeadlines(): DeadlineTable {
  return {};
}

export function armDeadline(table: DeadlineTable, id: DeadlineId, at: number): DeadlineTable {
  return { ...table, [id]: at };
}

export function cancelDeadline(table: DeadlineTable, id: DeadlineId): DeadlineTable {
  if (table[id] === undefined) return table;
  const next = { ...table };
  delete next[id];
  return next;
}

export function earliestDeadline(table: DeadlineTable): { id: DeadlineId; at: number } | null {
  let earliest: { id: DeadlineId; at: number } | null = null;
  for (const id of DEADLINE_IDS) {
    const at = table[id];
    if (at === undefined) continue;
    if (earliest === null || at < earliest.at) {
      earliest = { id, at };
    }
  }
  return earliest;
}

export function dueDeadlines(table: DeadlineTable, now: number): DeadlineId[] {
  const due: Array<{ id: DeadlineId; at: number }> = [];
  for (const id of DEADLINE_IDS) {
    const at = table[id];
    if (at !== undefined && at <= now) {
      due.push({ id, at });
    }
  }
  due.sort((a, b) => a.at - b.at);
  return due.map(entry => entry.id);
}

export function nextAlarmAt(table: DeadlineTable): number | null {
  return earliestDeadline(table)?.at ?? null;
}
