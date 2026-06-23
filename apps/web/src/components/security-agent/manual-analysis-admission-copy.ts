export { manualAnalysisAdmissionCopy } from './security-agent-command-copy';

export const manualAnalysisCapacityFullCopy =
  'Analysis capacity is full. Wait for an active analysis to finish.';

type ManualAnalysisCapacityReservation = {
  findingId: string;
  runningCount: number;
  concurrencyLimit: number;
  startingAnalysisIds: ReadonlySet<string>;
  localReservationIds: Set<string>;
};

export function tryReserveManualAnalysisCapacity({
  findingId,
  runningCount,
  concurrencyLimit,
  startingAnalysisIds,
  localReservationIds,
}: ManualAnalysisCapacityReservation): boolean {
  if (startingAnalysisIds.has(findingId) || localReservationIds.has(findingId)) return false;

  let unconfirmedReservationCount = 0;
  for (const reservedFindingId of localReservationIds) {
    if (!startingAnalysisIds.has(reservedFindingId)) unconfirmedReservationCount += 1;
  }
  if (runningCount + unconfirmedReservationCount >= concurrencyLimit) return false;

  localReservationIds.add(findingId);
  return true;
}

export function isAwaitingManualAnalysisAdmission(
  hasActiveStartCommand: boolean,
  analysisStatus: string | null | undefined
): boolean {
  return hasActiveStartCommand && analysisStatus !== 'pending' && analysisStatus !== 'running';
}
