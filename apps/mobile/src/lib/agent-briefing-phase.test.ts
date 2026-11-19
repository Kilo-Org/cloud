import { describe, expect, it } from 'vitest';

import {
  selectBriefingDetailPhase,
  selectBriefingListPhase,
  selectBriefingSettingsPhase,
} from './agent-briefing-state';

const noSignals = {
  offline: false,
  isPending: false,
  isError: false,
  accessDenied: false,
} as const;

/** Every combination of the listed boolean signals, as flat input rows. */
function combinations(keys: readonly string[]): Record<string, boolean>[] {
  let rows: Record<string, boolean>[] = [{}];
  for (const key of keys) {
    rows = rows.flatMap(row => [
      { ...row, [key]: false },
      { ...row, [key]: true },
    ]);
  }
  return rows;
}

describe('selectBriefingListPhase', () => {
  it('names the phase each combination of read signals is in', () => {
    const cases: [string, Parameters<typeof selectBriefingListPhase>[0], string][] = [
      ['a first fetch', { ...noSignals, hasReports: false, isPending: true }, 'loading'],
      [
        'an offline-paused first fetch: pending forever, so connectivity decides',
        { ...noSignals, hasReports: false, isPending: true, offline: true },
        'offline',
      ],
      [
        'an offline cache miss that also failed',
        { ...noSignals, hasReports: false, isError: true, offline: true },
        'offline',
      ],
      [
        'a denial the abandoned pending read settles as',
        { ...noSignals, hasReports: false, isPending: true, accessDenied: true },
        'denied',
      ],
      [
        'a denial that also carries a transport error',
        { ...noSignals, hasReports: false, isError: true, accessDenied: true },
        'denied',
      ],
      ['a cached list while offline', { ...noSignals, hasReports: true, offline: true }, 'ready'],
      [
        'a cached list behind a failed refetch',
        { ...noSignals, hasReports: true, isError: true },
        'ready',
      ],
      ['a settled list with nothing scheduled', { ...noSignals, hasReports: false }, 'empty'],
      [
        'a retryable failure with no cache',
        { ...noSignals, hasReports: false, isError: true },
        'failed',
      ],
    ];
    for (const [label, input, expected] of cases) {
      expect(selectBriefingListPhase(input), label).toBe(expected);
    }
  });

  it('answers with exactly one phase for every combination of its signals', () => {
    const phases = new Set<string>();
    for (const row of combinations([
      'hasReports',
      'offline',
      'isPending',
      'isError',
      'accessDenied',
    ])) {
      phases.add(selectBriefingListPhase(row as Parameters<typeof selectBriefingListPhase>[0]));
    }
    expect([...phases].sort()).toEqual([
      'denied',
      'empty',
      'failed',
      'loading',
      'offline',
      'ready',
    ]);
  });
});

describe('selectBriefingDetailPhase', () => {
  it('names the phase each combination of read signals is in', () => {
    const cases: [string, Parameters<typeof selectBriefingDetailPhase>[0], string][] = [
      [
        'a first fetch',
        { ...noSignals, hasReport: false, missing: false, isPending: true },
        'loading',
      ],
      [
        'an offline-paused first fetch',
        { ...noSignals, hasReport: false, missing: false, isPending: true, offline: true },
        'offline',
      ],
      [
        'a denial the abandoned pending read settles as',
        { ...noSignals, hasReport: false, missing: false, isPending: true, accessDenied: true },
        'denied',
      ],
      [
        'a report the server says is gone, which is not a lost access',
        { ...noSignals, hasReport: false, missing: true },
        'missing',
      ],
      [
        'a missing report while offline still says offline',
        { ...noSignals, hasReport: false, missing: true, offline: true },
        'offline',
      ],
      [
        'a cached report while offline',
        { ...noSignals, hasReport: true, missing: false, offline: true },
        'ready',
      ],
      [
        'a cached report behind a failed refetch',
        { ...noSignals, hasReport: true, missing: false, isError: true },
        'ready',
      ],
      [
        'a retryable failure with no cache',
        { ...noSignals, hasReport: false, missing: false, isError: true },
        'failed',
      ],
      [
        'a settled read that answered neither data nor an error',
        { ...noSignals, hasReport: false, missing: false },
        'failed',
      ],
    ];
    for (const [label, input, expected] of cases) {
      expect(selectBriefingDetailPhase(input), label).toBe(expected);
    }
  });

  it('answers with exactly one phase for every combination of its signals', () => {
    const phases = new Set<string>();
    for (const row of combinations([
      'hasReport',
      'offline',
      'isPending',
      'isError',
      'accessDenied',
      'missing',
    ])) {
      phases.add(selectBriefingDetailPhase(row as Parameters<typeof selectBriefingDetailPhase>[0]));
    }
    expect([...phases].sort()).toEqual([
      'denied',
      'failed',
      'loading',
      'missing',
      'offline',
      'ready',
    ]);
  });
});

describe('selectBriefingSettingsPhase', () => {
  it('names the phase each combination of read signals is in', () => {
    const cases: [string, Parameters<typeof selectBriefingSettingsPhase>[0], string][] = [
      ['a first fetch', { ...noSignals, hasPreferences: false, isPending: true }, 'loading'],
      [
        'an offline-paused first fetch',
        { ...noSignals, hasPreferences: false, isPending: true, offline: true },
        'offline',
      ],
      [
        'a denial the abandoned pending read settles as',
        { ...noSignals, hasPreferences: false, isPending: true, accessDenied: true },
        'denied',
      ],
      [
        'cached preferences while offline',
        { ...noSignals, hasPreferences: true, offline: true },
        'ready',
      ],
      [
        'cached preferences behind a failed refetch',
        { ...noSignals, hasPreferences: true, isError: true },
        'ready',
      ],
      [
        'a retryable failure with no cache',
        { ...noSignals, hasPreferences: false, isError: true },
        'failed',
      ],
      [
        'a settled read that answered neither data nor an error',
        { ...noSignals, hasPreferences: false },
        'failed',
      ],
    ];
    for (const [label, input, expected] of cases) {
      expect(selectBriefingSettingsPhase(input), label).toBe(expected);
    }
  });

  it('answers with exactly one phase for every combination of its signals', () => {
    const phases = new Set<string>();
    for (const row of combinations([
      'hasPreferences',
      'offline',
      'isPending',
      'isError',
      'accessDenied',
    ])) {
      phases.add(
        selectBriefingSettingsPhase(row as Parameters<typeof selectBriefingSettingsPhase>[0])
      );
    }
    expect([...phases].sort()).toEqual(['denied', 'failed', 'loading', 'offline', 'ready']);
  });
});
