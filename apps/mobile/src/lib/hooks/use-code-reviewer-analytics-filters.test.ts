import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearCodeReviewerAnalyticsFilters,
  type CodeReviewerAnalyticsPeriod,
  type CodeReviewerAnalyticsPlatform,
  type CodeReviewerAnalyticsSelection,
  getCodeReviewerAnalyticsSelection,
  setCodeReviewerAnalyticsPeriod,
  setCodeReviewerAnalyticsPlatform,
  subscribeCodeReviewerAnalyticsFilters,
} from './use-code-reviewer-analytics-filters';

// The store is module-level and shared by every test in this file, so each case
// uses its own organization id and the clear below starts the next one clean.
afterEach(() => {
  clearCodeReviewerAnalyticsFilters();
});

describe('code reviewer analytics filters', () => {
  it('defaults an organization with no entry to GitHub over 30 days', () => {
    const selection = getCodeReviewerAnalyticsSelection('org-analytics-default');

    expect(selection).toEqual({ platform: 'github', period: 30 });
    // One stable object per organization without an entry: `useSyncExternalStore`
    // compares snapshots by identity, so a fresh default per read would re-render
    // on every store check.
    expect(getCodeReviewerAnalyticsSelection('org-analytics-default')).toBe(selection);
  });

  it('reads back a chosen period and platform, each keeping the other', () => {
    const scope = 'org-analytics-set';
    const period: CodeReviewerAnalyticsPeriod = 90;
    const platform: CodeReviewerAnalyticsPlatform = 'gitlab';

    setCodeReviewerAnalyticsPeriod(scope, period);
    expect(getCodeReviewerAnalyticsSelection(scope)).toEqual({ platform: 'github', period: 90 });

    setCodeReviewerAnalyticsPlatform(scope, platform);
    const selection: CodeReviewerAnalyticsSelection = getCodeReviewerAnalyticsSelection(scope);
    expect(selection).toEqual({ platform: 'gitlab', period: 90 });
  });

  it('keeps two organizations on their own selection', () => {
    setCodeReviewerAnalyticsPeriod('org-analytics-first', 7);
    setCodeReviewerAnalyticsPlatform('org-analytics-second', 'gitlab');

    expect(getCodeReviewerAnalyticsSelection('org-analytics-first')).toEqual({
      platform: 'github',
      period: 7,
    });
    expect(getCodeReviewerAnalyticsSelection('org-analytics-second')).toEqual({
      platform: 'gitlab',
      period: 30,
    });
  });

  it('does not notify a subscriber for a set of the current value', () => {
    const scope = 'org-analytics-noop';
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeCodeReviewerAnalyticsFilters(scope, listener);

    // Both defaults are re-set: the selection does not change, so a mounted
    // screen behind this scope must not re-render.
    setCodeReviewerAnalyticsPlatform(scope, 'github');
    setCodeReviewerAnalyticsPeriod(scope, 30);
    expect(listener).not.toHaveBeenCalled();

    setCodeReviewerAnalyticsPeriod(scope, 7);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('does not notify a subscription that was removed', () => {
    const scope = 'org-analytics-unsubscribed';
    const listener = vi.fn<() => void>();

    subscribeCodeReviewerAnalyticsFilters(scope, listener)();
    setCodeReviewerAnalyticsPeriod(scope, 90);

    expect(listener).not.toHaveBeenCalled();
  });

  it('returns every organization to the default and notifies the mounted one', () => {
    const mounted = 'org-analytics-clear-mounted';
    const other = 'org-analytics-clear-other';
    setCodeReviewerAnalyticsPlatform(mounted, 'gitlab');
    setCodeReviewerAnalyticsPeriod(other, 7);
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeCodeReviewerAnalyticsFilters(mounted, listener);

    clearCodeReviewerAnalyticsFilters();

    expect(getCodeReviewerAnalyticsSelection(mounted)).toEqual({ platform: 'github', period: 30 });
    expect(getCodeReviewerAnalyticsSelection(other)).toEqual({ platform: 'github', period: 30 });
    // The screen behind this organization is still mounted across the account
    // boundary, so its controls re-render on the default.
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('keeps a later selection after the clear', () => {
    const scope = 'org-analytics-after-clear';
    setCodeReviewerAnalyticsPlatform(scope, 'gitlab');

    clearCodeReviewerAnalyticsFilters();
    setCodeReviewerAnalyticsPeriod(scope, 90);

    expect(getCodeReviewerAnalyticsSelection(scope)).toEqual({ platform: 'github', period: 90 });
  });
});
