import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  BYOK_FAILURE_REPORT_WINDOW_MS,
  claimFailureReport,
  MAX_TRACKED_FAILURES,
  resetFailureReportsForTest,
} from './failure-reports';

beforeEach(() => {
  resetFailureReportsForTest();
});

describe('claimFailureReport', () => {
  test('claims a key once and suppresses it until the window passes', () => {
    expect(claimFailureReport('window-key', 0)).toBe(true);
    expect(claimFailureReport('window-key', BYOK_FAILURE_REPORT_WINDOW_MS - 1)).toBe(false);
    expect(claimFailureReport('window-key', BYOK_FAILURE_REPORT_WINDOW_MS)).toBe(true);
  });

  test('claims each key independently', () => {
    expect(claimFailureReport('first-key', 5_000)).toBe(true);
    expect(claimFailureReport('second-key', 5_000)).toBe(true);
    expect(claimFailureReport('first-key', 5_001)).toBe(false);
  });

  test('starts a fresh window after a reset', () => {
    expect(claimFailureReport('reset-key', 0)).toBe(true);
    expect(claimFailureReport('reset-key', 0)).toBe(false);

    resetFailureReportsForTest();

    expect(claimFailureReport('reset-key', 0)).toBe(true);
  });

  test('forgets the least recently reported key once the map is full', () => {
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
});
