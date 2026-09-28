import { afterEach, describe, expect, it } from 'vitest';

import { getSurfaceExtras, setSurfaceExtras } from './surface-extras';

const EMPTY = { newestSessionTitle: null, actionFeedback: null } as const;

afterEach(() => {
  setSurfaceExtras({ ...EMPTY });
});

describe('glanceable surface extras', () => {
  it('starts empty', () => {
    expect(getSurfaceExtras()).toEqual({
      newestSessionTitle: null,
      actionFeedback: null,
    });
  });

  it('replaces the whole value, so a stale field cannot survive', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the build', actionFeedback: null });
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'approving' });

    expect(getSurfaceExtras()).toEqual({
      newestSessionTitle: null,
      actionFeedback: 'approving',
    });
  });

  it('clears back to the empty value', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the build', actionFeedback: 'couldNotApprove' });

    setSurfaceExtras({ ...EMPTY });

    expect(getSurfaceExtras()).toEqual({
      newestSessionTitle: null,
      actionFeedback: null,
    });
  });
});
