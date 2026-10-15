import {
  canEnablePrWatch,
  validWatchPrPreferences,
  watchPrObservationLabel,
  watchPrMatchesIdentity,
  watchPrQueryInput,
} from './watch-pr-view';
import type { WatchPrProjection } from '@/lib/cloud-agent/watch-pr-events';

const projection: WatchPrProjection = {
  version: 1,
  evidence: [],
  pending: [],
  ambiguous: false,
  needsAttention: false,
  truncated: false,
  prUpdatedAt: null,
  prState: null,
  headPushObserved: false,
  basePushObserved: false,
};

describe('Watch PR view', () => {
  const pr = { platform: 'github', url: 'https://github.com/Kilo/Widgets/pull/12', number: 12 };

  it('binds queries and enablement to the displayed canonical PR, not just the session', () => {
    expect(watchPrQueryInput('ses_source', pr)).toEqual({
      sessionId: 'ses_source',
      expectedRepoUrl: 'https://github.com/kilo/widgets',
      expectedPrNumber: 12,
    });
    expect(
      watchPrQueryInput('ses_source', { ...pr, url: pr.url.replace('/12', '/13'), number: 13 })
    ).not.toEqual(watchPrQueryInput('ses_source', pr));
  });

  it('separates queries on a session switch even when the displayed PR stays the same', () => {
    expect(watchPrQueryInput('ses_other', pr)).toEqual({
      ...watchPrQueryInput('ses_source', pr),
      sessionId: 'ses_other',
    });
    expect(watchPrQueryInput('ses_other', pr)).not.toEqual(watchPrQueryInput('ses_source', pr));
  });

  it.each([
    { number: 13 },
    { platform: 'gitlab' },
    { url: 'https://gitlab.com/kilo/widgets/pull/12' },
    { url: 'not-a-pr' },
  ])('rejects inconsistent displayed PR identity %j', override => {
    expect(watchPrQueryInput('ses_source', { ...pr, ...override })).toBeNull();
  });

  it('only exposes controls for a watch matching the displayed repository and PR number', () => {
    const input = watchPrQueryInput('ses_source', pr);
    const watch = { repo_url: 'https://github.com/kilo/widgets', pr_number: 12 };
    expect(watchPrMatchesIdentity(watch, input)).toBe(true);
    expect(watchPrMatchesIdentity({ ...watch, pr_number: 13 }, input)).toBe(false);
    expect(
      watchPrMatchesIdentity({ ...watch, repo_url: 'https://github.com/kilo/other' }, input)
    ).toBe(false);
    expect(watchPrMatchesIdentity(watch, null)).toBe(false);
  });
  it.each(['open', 'draft'])(
    'allows verified %s GitHub PRs only with backend eligibility',
    state => {
      expect(canEnablePrWatch({ platform: 'github', state }, true)).toBe(true);
      expect(canEnablePrWatch({ platform: 'github', state }, false)).toBe(false);
    }
  );

  it.each(['unknown', 'closed', 'merged'])('does not enable %s PRs', state => {
    expect(canEnablePrWatch({ platform: 'github', state }, true)).toBe(false);
  });

  it('does not enable other platforms', () => {
    expect(canEnablePrWatch({ platform: 'gitlab', state: 'open' }, true)).toBe(false);
  });

  it('does not claim merge readiness from an empty projection', () => {
    expect(watchPrObservationLabel(projection)).toBe('No observed problems');
    expect(
      watchPrObservationLabel({
        ...projection,
        pending: [{ key: 'check', reason: 'failed_check' }],
      })
    ).toBe('Observed problems');
  });

  it.each(['needsAttention', 'ambiguous', 'truncated'])(
    'surfaces %s even without pending problems',
    flag => {
      expect(watchPrObservationLabel({ ...projection, [flag]: true })).toBe('Needs attention');
    }
  );

  it('validates explicit model, duration, and bounded saved attempt preferences', () => {
    expect(validWatchPrPreferences('provider/model', 24, 2, 10)).toBe(true);
    expect(validWatchPrPreferences('', 24, 2, 10)).toBe(false);
    expect(validWatchPrPreferences('   ', 24, 2, 10)).toBe(false);
    expect(validWatchPrPreferences('m'.repeat(201), 24, 2, 10)).toBe(false);
    expect(validWatchPrPreferences('model', 25, 2, 10)).toBe(false);
    expect(validWatchPrPreferences('model', NaN, 2, 10)).toBe(false);
    expect(validWatchPrPreferences('model', 0, 2, 10)).toBe(false);
    expect(validWatchPrPreferences('model', 1, 3, 10)).toBe(false);
    expect(validWatchPrPreferences('model', 1, 2, 1)).toBe(false);
    expect(validWatchPrPreferences('model', 1, 1, 11)).toBe(false);
    expect(validWatchPrPreferences('model', 1, 1.5, 10)).toBe(false);
  });
});
