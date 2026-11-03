import { describe, expect, test } from '@jest/globals';
import {
  BYOK_FAILURE_REPORT_WINDOW_MS,
  claimFailureReport,
  MAX_TRACKED_FAILURES,
} from './failure-reports';

describe('claimFailureReport', () => {
  test('claims a key once and suppresses it until the window passes', () => {
    expect(claimFailureReport('first-key', 1_000)).toBe(true);
    expect(claimFailureReport('first-key', 1_000 + BYOK_FAILURE_REPORT_WINDOW_MS - 1)).toBe(false);
    expect(claimFailureReport('first-key', 1_000 + BYOK_FAILURE_REPORT_WINDOW_MS)).toBe(true);
  });

  test('claims each key independently', () => {
    expect(claimFailureReport('second-key', 5_000)).toBe(true);
    expect(claimFailureReport('third-key', 5_000)).toBe(true);
    expect(claimFailureReport('second-key', 5_001)).toBe(false);
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
