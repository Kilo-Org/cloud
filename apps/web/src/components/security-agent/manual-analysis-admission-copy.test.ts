import { describe, expect, test } from '@jest/globals';
import {
  isAwaitingManualAnalysisAdmission,
  manualAnalysisAdmissionCopy,
  tryReserveManualAnalysisCapacity,
} from './manual-analysis-admission-copy';

describe('manualAnalysisAdmissionCopy', () => {
  test('describes manual analysis as queued admission', () => {
    expect(manualAnalysisAdmissionCopy.successTitle).toMatch(/queued/i);
    expect(manualAnalysisAdmissionCopy.failureTitle).toMatch(/failed to queue/i);
    expect(manualAnalysisAdmissionCopy.pendingLabel).toMatch(/queue/i);
  });

  test('stops showing admission progress after analysis is persisted as active', () => {
    expect(isAwaitingManualAnalysisAdmission(true, null)).toBe(true);
    expect(isAwaitingManualAnalysisAdmission(true, 'failed')).toBe(true);
    expect(isAwaitingManualAnalysisAdmission(true, 'completed')).toBe(true);
    expect(isAwaitingManualAnalysisAdmission(true, 'pending')).toBe(false);
    expect(isAwaitingManualAnalysisAdmission(true, 'running')).toBe(false);
    expect(isAwaitingManualAnalysisAdmission(false, null)).toBe(false);
  });

  test('reserves only the available slots across rapid analysis requests', () => {
    const localReservationIds = new Set<string>();
    const reserve = (findingId: string) =>
      tryReserveManualAnalysisCapacity({
        findingId,
        runningCount: 1,
        concurrencyLimit: 3,
        startingAnalysisIds: new Set(),
        localReservationIds,
      });

    expect(reserve('finding-1')).toBe(true);
    expect(reserve('finding-2')).toBe(true);
    expect(reserve('finding-3')).toBe(false);
    expect(localReservationIds).toEqual(new Set(['finding-1', 'finding-2']));
  });

  test('does not reserve at full capacity or twice for the same finding', () => {
    const localReservationIds = new Set<string>();
    const startingAnalysisIds = new Set(['starting-finding']);

    expect(
      tryReserveManualAnalysisCapacity({
        findingId: 'full-capacity-finding',
        runningCount: 3,
        concurrencyLimit: 3,
        startingAnalysisIds,
        localReservationIds,
      })
    ).toBe(false);
    expect(
      tryReserveManualAnalysisCapacity({
        findingId: 'starting-finding',
        runningCount: 1,
        concurrencyLimit: 3,
        startingAnalysisIds,
        localReservationIds,
      })
    ).toBe(false);
    expect(
      tryReserveManualAnalysisCapacity({
        findingId: 'new-finding',
        runningCount: 1,
        concurrencyLimit: 3,
        startingAnalysisIds,
        localReservationIds,
      })
    ).toBe(true);
    expect(
      tryReserveManualAnalysisCapacity({
        findingId: 'new-finding',
        runningCount: 1,
        concurrencyLimit: 3,
        startingAnalysisIds,
        localReservationIds,
      })
    ).toBe(false);
    expect(localReservationIds).toEqual(new Set(['new-finding']));
  });
});
