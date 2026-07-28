import { beforeEach, describe, expect, it } from 'vitest';

import { applyMergeSuccessEffects } from './merge-success-effects';
import {
  __resetMergePartialSuccessStoreForTests,
  consumeMergePartialSuccess,
} from './merge-result-banner-store';

const REF = { owner: 'octocat', repo: 'hello', number: 1 };

beforeEach(() => {
  __resetMergePartialSuccessStoreForTests();
});

describe('applyMergeSuccessEffects', () => {
  it('partial success writes the banner and celebrates', () => {
    const result = {
      merged: true,
      sha: 'sha',
      branchDeleted: false,
      branchDeleteError: 'Reference does not exist',
    } as const;

    const { celebrate } = applyMergeSuccessEffects(result, REF);

    expect(celebrate).toBe(true);
    expect(consumeMergePartialSuccess(REF)).toEqual({ reason: 'Reference does not exist' });
  });

  it('clean success celebrates without writing a banner', () => {
    const result = { merged: true, sha: 'sha', branchDeleted: true } as const;

    const { celebrate } = applyMergeSuccessEffects(result, REF);

    expect(celebrate).toBe(true);
    expect(consumeMergePartialSuccess(REF)).toBeNull();
  });

  it('incomplete result is unreachable in the sheet because the hook throws first; defensively it does not celebrate or write a banner', () => {
    const result = { merged: false, sha: 'sha', branchDeleted: false } as const;

    const { celebrate } = applyMergeSuccessEffects(result, REF);

    expect(celebrate).toBe(false);
    expect(consumeMergePartialSuccess(REF)).toBeNull();
  });
});
