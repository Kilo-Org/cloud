import { describe, expect, test } from '@jest/globals';
import { BYOK_FAILURE_REPORT_WINDOW_MS, MAX_TRACKED_FAILURES } from './failure-reports';

/**
 * The window lives in the module, so every case starts from an empty one by loading a fresh
 * instance instead of resetting shared state.
 */
async function loadClaimFailureReport() {
  jest.resetModules();
  const { claimFailureReport } = await import('./failure-reports');
  return claimFailureReport;
}

describe('claimFailureReport', () => {
  test('claims a key once and suppresses it until the window passes', async () => {
    const claimFailureReport = await loadClaimFailureReport();

    expect(claimFailureReport('window-key', 0)).toBe(true);
    expect(claimFailureReport('window-key', BYOK_FAILURE_REPORT_WINDOW_MS - 1)).toBe(false);
    expect(claimFailureReport('window-key', BYOK_FAILURE_REPORT_WINDOW_MS)).toBe(true);
  });

  test('claims each key independently', async () => {
    const claimFailureReport = await loadClaimFailureReport();

    expect(claimFailureReport('first-key', 5_000)).toBe(true);
    expect(claimFailureReport('second-key', 5_000)).toBe(true);
    expect(claimFailureReport('first-key', 5_001)).toBe(false);
    expect(claimFailureReport('second-key', 5_001)).toBe(false);
  });

  test('forgets the least recently reported key once the map is full', async () => {
    const claimFailureReport = await loadClaimFailureReport();
    const overflow = 5;

    for (let index = 0; index < MAX_TRACKED_FAILURES + overflow; index += 1) {
      expect(claimFailureReport(`cap-key-${index}`, 10_000)).toBe(true);
    }
    // Keys older than the cap are forgotten, so they report again inside their window;
    // the newest keys stay suppressed.
    expect(claimFailureReport('cap-key-0', 10_001)).toBe(true);
    expect(claimFailureReport(`cap-key-${MAX_TRACKED_FAILURES + overflow - 1}`, 10_001)).toBe(
      false
    );
  });

  test('reports again after a restart, which starts an empty window', async () => {
    const beforeRestart = await loadClaimFailureReport();
    expect(beforeRestart('restart-key', 0)).toBe(true);
    expect(beforeRestart('restart-key', 0)).toBe(false);

    const afterRestart = await loadClaimFailureReport();

    expect(afterRestart('restart-key', 0)).toBe(true);
  });
});
