import { describe, expect, test } from '@jest/globals';
import { BYOK_FAILURE_REPORT_WINDOW_MS, claimFailureReport } from './failure-reports';

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
});
