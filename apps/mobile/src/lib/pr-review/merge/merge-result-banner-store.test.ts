import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetMergePartialSuccessStoreForTests,
  clearMergePartialSuccess,
  consumeMergePartialSuccess,
  setMergePartialSuccess,
  type PrRef,
} from './merge-result-banner-store';

const ref: PrRef = { owner: 'octocat', repo: 'hello', number: 1 };

afterEach(() => {
  __resetMergePartialSuccessStoreForTests();
});

describe('merge partial-success banner store', () => {
  it('returns null when no entry has been set', () => {
    expect(consumeMergePartialSuccess(ref)).toBeNull();
  });

  it('returns the stored value once and then clears it', () => {
    setMergePartialSuccess(ref, { reason: 'Reference does not exist' });

    expect(consumeMergePartialSuccess(ref)).toEqual({ reason: 'Reference does not exist' });
    // Consume is destructive — a second read returns null.
    expect(consumeMergePartialSuccess(ref)).toBeNull();
  });

  it('keeps entries isolated per PR (owner/repo/number)', () => {
    const a: PrRef = { owner: 'octocat', repo: 'hello', number: 1 };
    const b: PrRef = { owner: 'octocat', repo: 'hello', number: 2 };
    const c: PrRef = { owner: 'octocat', repo: 'world', number: 1 };

    setMergePartialSuccess(a, { reason: 'for a' });
    setMergePartialSuccess(b, { reason: 'for b' });
    setMergePartialSuccess(c, { reason: 'for c' });

    expect(consumeMergePartialSuccess(a)).toEqual({ reason: 'for a' });
    expect(consumeMergePartialSuccess(b)).toEqual({ reason: 'for b' });
    expect(consumeMergePartialSuccess(c)).toEqual({ reason: 'for c' });
    expect(consumeMergePartialSuccess(a)).toBeNull();
  });

  it('treats owner and repo as case-insensitive keys', () => {
    setMergePartialSuccess({ owner: 'OctoCat', repo: 'Hello', number: 1 }, { reason: 'x' });

    expect(consumeMergePartialSuccess({ owner: 'octocat', repo: 'hello', number: 1 })).toEqual({
      reason: 'x',
    });
  });

  it('clearMergePartialSuccess removes a specific entry without affecting siblings', () => {
    const a: PrRef = { owner: 'octocat', repo: 'hello', number: 1 };
    const b: PrRef = { owner: 'octocat', repo: 'hello', number: 2 };

    setMergePartialSuccess(a, { reason: 'a' });
    setMergePartialSuccess(b, { reason: 'b' });

    clearMergePartialSuccess(a);
    expect(consumeMergePartialSuccess(a)).toBeNull();
    expect(consumeMergePartialSuccess(b)).toEqual({ reason: 'b' });
  });
});
