import { describe, expect, it } from 'vitest';

import {
  type CloudAgentEligibilityState,
  filterModelOptionsForLimitedAccess,
  isLimitedAccess,
  limitedAccessAllowsModel,
  PENDING_ELIGIBILITY,
  resolveCloudAgentEligibilityState,
  selectionNeedsCredits,
} from '@/lib/cloud-agent-eligibility';

const FULL: CloudAgentEligibilityState = {
  kind: 'ready',
  eligibility: { balance: 5, minBalance: 1, accessLevel: 'full', isEligible: true },
};
const LIMITED: CloudAgentEligibilityState = {
  kind: 'ready',
  eligibility: { balance: 0.4, minBalance: 1, accessLevel: 'limited', isEligible: false },
};
const FAILED: CloudAgentEligibilityState = { kind: 'failed' };

const MODELS = [
  { id: 'paid/model', isFree: false, hasUserByokAvailable: false },
  { id: 'free/model', isFree: true },
  { id: 'byok/model', hasUserByokAvailable: true },
  // A row the catalog gave no pricing flags for: not free, whatever it costs.
  { id: 'unknown/model' },
];

describe('resolveCloudAgentEligibilityState', () => {
  it('claims nothing while the read is pending', () => {
    expect(
      resolveCloudAgentEligibilityState({ data: undefined, isPending: true, isError: false })
    ).toEqual(PENDING_ELIGIBILITY);
  });

  it('reports the answer once it arrives', () => {
    const state = resolveCloudAgentEligibilityState({
      data: LIMITED.eligibility,
      isPending: false,
      isError: false,
    });
    expect(state).toEqual(LIMITED);
  });

  it('reports the failed read', () => {
    expect(
      resolveCloudAgentEligibilityState({ data: undefined, isPending: false, isError: true })
    ).toEqual(FAILED);
  });

  it('keeps the last answer when a refetch fails over it', () => {
    // A refetch that errors leaves the previous answer in `data`; a stale balance
    // is a better basis for the gate than no balance at all.
    expect(
      resolveCloudAgentEligibilityState({
        data: FULL.eligibility,
        isPending: false,
        isError: true,
      })
    ).toEqual(FULL);
  });
});

describe('isLimitedAccess', () => {
  it('is true only for an answered balance under the minimum', () => {
    expect(isLimitedAccess(LIMITED)).toBe(true);
    expect(isLimitedAccess(FULL)).toBe(false);
    expect(isLimitedAccess(FAILED)).toBe(false);
    expect(isLimitedAccess(PENDING_ELIGIBILITY)).toBe(false);
  });

  it('treats an access level other than full as limited', () => {
    // The router answers `full` or `limited` today; a future `blocked` answer
    // must keep the composer on the models the balance covers.
    const blocked: CloudAgentEligibilityState = {
      kind: 'ready',
      eligibility: { balance: 0, minBalance: 1, accessLevel: 'blocked', isEligible: false },
    };
    expect(isLimitedAccess(blocked)).toBe(true);
  });
});

describe('limitedAccessAllowsModel', () => {
  it('allows a free or BYOK row and nothing else', () => {
    expect(limitedAccessAllowsModel({ isFree: true })).toBe(true);
    expect(limitedAccessAllowsModel({ hasUserByokAvailable: true })).toBe(true);
    expect(limitedAccessAllowsModel({ isFree: false, hasUserByokAvailable: false })).toBe(false);
    // A row that carries neither flag is not free: the server would refuse it.
    expect(limitedAccessAllowsModel({})).toBe(false);
  });
});

describe('filterModelOptionsForLimitedAccess', () => {
  it('keeps the whole catalog when the balance is enough', () => {
    expect(filterModelOptionsForLimitedAccess(MODELS, FULL)).toEqual(MODELS);
  });

  it('keeps the whole catalog while the read is pending or failed', () => {
    expect(filterModelOptionsForLimitedAccess(MODELS, PENDING_ELIGIBILITY)).toEqual(MODELS);
    expect(filterModelOptionsForLimitedAccess(MODELS, FAILED)).toEqual(MODELS);
  });

  it('keeps only the free and BYOK rows under a limited balance', () => {
    expect(filterModelOptionsForLimitedAccess(MODELS, LIMITED).map(option => option.id)).toEqual([
      'free/model',
      'byok/model',
    ]);
  });

  it('returns a copy, so a caller cannot mutate the catalog through it', () => {
    const filtered = filterModelOptionsForLimitedAccess(MODELS, FULL);
    filtered.pop();
    expect(MODELS).toHaveLength(4);
  });
});

describe('selectionNeedsCredits', () => {
  it('is false when the balance is enough, whatever the model costs', () => {
    expect(selectionNeedsCredits({ state: FULL, selection: 'paid/model', option: MODELS[0] })).toBe(
      false
    );
  });

  it('is false while the read is pending or failed, so Start is never blocked on a guess', () => {
    expect(
      selectionNeedsCredits({
        state: PENDING_ELIGIBILITY,
        selection: 'paid/model',
        option: MODELS[0],
      })
    ).toBe(false);
    expect(
      selectionNeedsCredits({ state: FAILED, selection: 'paid/model', option: MODELS[0] })
    ).toBe(false);
  });

  it('is true for a paid selection under a limited balance', () => {
    expect(
      selectionNeedsCredits({ state: LIMITED, selection: 'paid/model', option: MODELS[0] })
    ).toBe(true);
  });

  it('is false for a free or BYOK selection under a limited balance', () => {
    expect(
      selectionNeedsCredits({ state: LIMITED, selection: 'free/model', option: MODELS[1] })
    ).toBe(false);
    expect(
      selectionNeedsCredits({ state: LIMITED, selection: 'byok/model', option: MODELS[2] })
    ).toBe(false);
  });

  it('is true for a selection the catalog cannot name', () => {
    // A remembered model the catalog dropped still needs credits: the server
    // cannot tell that it is free, and the picker holds no free row for it.
    expect(
      selectionNeedsCredits({ state: LIMITED, selection: 'gone/model', option: undefined })
    ).toBe(true);
  });

  it('is false with no selection at all', () => {
    // An empty model is the `model-missing` blocker, not this one.
    expect(selectionNeedsCredits({ state: LIMITED, selection: '', option: undefined })).toBe(false);
  });
});
