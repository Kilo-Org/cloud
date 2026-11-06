import { describe, expect, test } from '@jest/globals';
import { claimReportWindow, MAX_TRACKED_REPORT_KEYS, REPORT_WINDOW_MS } from './report-window';

describe('claimReportWindow', () => {
  test('claims a key once and suppresses it until the window passes', () => {
    expect(claimReportWindow('first-key', 1_000)).toBe(true);
    expect(claimReportWindow('first-key', 1_000 + REPORT_WINDOW_MS - 1)).toBe(false);
    expect(claimReportWindow('first-key', 1_000 + REPORT_WINDOW_MS)).toBe(true);
  });

  test('claims each key independently', () => {
    expect(claimReportWindow('second-key', 5_000)).toBe(true);
    expect(claimReportWindow('third-key', 5_000)).toBe(true);
    expect(claimReportWindow('second-key', 5_001)).toBe(false);
  });

  test('forgets the least recently reported key once the map is full', () => {
    const overflow = 5;
    for (let index = 0; index < MAX_TRACKED_REPORT_KEYS + overflow; index += 1) {
      expect(claimReportWindow(`cap-key-${index}`, 10_000)).toBe(true);
    }
    // Keys older than the cap are forgotten, so they report again inside their window;
    // the newest keys stay suppressed.
    expect(claimReportWindow('cap-key-0', 10_001)).toBe(true);
    expect(claimReportWindow(`cap-key-${MAX_TRACKED_REPORT_KEYS + overflow - 1}`, 10_001)).toBe(
      false
    );
  });
});
