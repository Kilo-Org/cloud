import {
  canEnablePrWatch,
  validWatchPrPreferences,
  watchPrObservationLabel,
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
