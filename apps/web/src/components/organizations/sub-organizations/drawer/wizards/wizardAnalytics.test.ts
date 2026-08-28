/** @jest-environment jsdom */
import type { RowOutcome } from './rowExecutor';
import {
  checkAndRecordWizardRun,
  isLargeSelection,
  isWithinRepeatRunWindow,
  LARGE_SELECTION_THRESHOLD,
  REPEAT_RUN_WINDOW_MS,
  summarizeFailures,
} from './wizardAnalytics';

describe('isLargeSelection', () => {
  it('is false below the threshold', () => {
    expect(isLargeSelection(LARGE_SELECTION_THRESHOLD - 1)).toBe(false);
  });

  it('is true at exactly the threshold', () => {
    expect(isLargeSelection(LARGE_SELECTION_THRESHOLD)).toBe(true);
  });

  it('is true above the threshold', () => {
    expect(isLargeSelection(LARGE_SELECTION_THRESHOLD + 10)).toBe(true);
  });

  it('is false for zero', () => {
    expect(isLargeSelection(0)).toBe(false);
  });
});

describe('isWithinRepeatRunWindow', () => {
  it('is false when there is no previous run', () => {
    expect(isWithinRepeatRunWindow(null, Date.now())).toBe(false);
  });

  it('is true when the previous run was just under the window ago', () => {
    const now = 1_000_000;
    const lastRunAt = now - (REPEAT_RUN_WINDOW_MS - 1);
    expect(isWithinRepeatRunWindow(lastRunAt, now)).toBe(true);
  });

  it('is false once the previous run is exactly the window ago', () => {
    const now = 1_000_000;
    const lastRunAt = now - REPEAT_RUN_WINDOW_MS;
    expect(isWithinRepeatRunWindow(lastRunAt, now)).toBe(false);
  });

  it('is false when the previous run is well outside the window', () => {
    const now = 1_000_000;
    const lastRunAt = now - REPEAT_RUN_WINDOW_MS * 2;
    expect(isWithinRepeatRunWindow(lastRunAt, now)).toBe(false);
  });
});

describe('checkAndRecordWizardRun', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('is not a repeat the first time a wizard type runs for a parent org', () => {
    expect(checkAndRecordWizardRun('parent-1', 'add', 1_000_000)).toBe(false);
  });

  it('is a repeat when run again for the same parent org and wizard type inside the window', () => {
    checkAndRecordWizardRun('parent-1', 'add', 1_000_000);
    const isRepeat = checkAndRecordWizardRun('parent-1', 'add', 1_000_000 + 1000);
    expect(isRepeat).toBe(true);
  });

  it('is not a repeat once the window has elapsed', () => {
    checkAndRecordWizardRun('parent-1', 'add', 1_000_000);
    const isRepeat = checkAndRecordWizardRun(
      'parent-1',
      'add',
      1_000_000 + REPEAT_RUN_WINDOW_MS + 1
    );
    expect(isRepeat).toBe(false);
  });

  it('does not treat a different wizard type for the same parent org as a repeat', () => {
    checkAndRecordWizardRun('parent-1', 'add', 1_000_000);
    const isRepeat = checkAndRecordWizardRun('parent-1', 'remove', 1_000_000 + 1000);
    expect(isRepeat).toBe(false);
  });

  it('does not treat the same wizard type for a different parent org as a repeat', () => {
    checkAndRecordWizardRun('parent-1', 'add', 1_000_000);
    const isRepeat = checkAndRecordWizardRun('parent-2', 'add', 1_000_000 + 1000);
    expect(isRepeat).toBe(false);
  });

  it('updates the recorded timestamp so a third run is judged against the second, not the first', () => {
    checkAndRecordWizardRun('parent-1', 'add', 1_000_000);
    checkAndRecordWizardRun('parent-1', 'add', 1_000_000 + 1000);
    const isRepeat = checkAndRecordWizardRun(
      'parent-1',
      'add',
      1_000_000 + 1000 + REPEAT_RUN_WINDOW_MS + 1
    );
    expect(isRepeat).toBe(false);
  });
});

describe('summarizeFailures', () => {
  function outcome(status: RowOutcome['status']): RowOutcome {
    switch (status) {
      case 'failed':
        return { status: 'failed', error: 'boom' };
      case 'skipped':
        return { status: 'skipped', reason: 'already a member' };
      default:
        return { status } as RowOutcome;
    }
  }

  it('reports no failure when all rows succeeded', () => {
    const outcomes = [outcome('succeeded'), outcome('succeeded')];
    expect(summarizeFailures(outcomes)).toEqual({
      failedCount: 0,
      totalCount: 2,
      hasFailure: false,
    });
  });

  it('reports no failure when rows are only succeeded or skipped', () => {
    const outcomes = [outcome('succeeded'), outcome('skipped')];
    expect(summarizeFailures(outcomes)).toEqual({
      failedCount: 0,
      totalCount: 2,
      hasFailure: false,
    });
  });

  it('reports a failure when at least one row failed', () => {
    const outcomes = [outcome('succeeded'), outcome('failed'), outcome('skipped')];
    expect(summarizeFailures(outcomes)).toEqual({
      failedCount: 1,
      totalCount: 3,
      hasFailure: true,
    });
  });

  it('counts every failed row, not just the first', () => {
    const outcomes = [outcome('failed'), outcome('failed'), outcome('succeeded')];
    expect(summarizeFailures(outcomes)).toEqual({
      failedCount: 2,
      totalCount: 3,
      hasFailure: true,
    });
  });

  it('reports no failure for an empty outcome list', () => {
    expect(summarizeFailures([])).toEqual({ failedCount: 0, totalCount: 0, hasFailure: false });
  });
});
