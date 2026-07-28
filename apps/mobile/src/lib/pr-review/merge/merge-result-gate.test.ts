import { describe, expect, it } from 'vitest';

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

import {
  assertMergeResult,
  gateMergeResult,
  type MergePullRequestResult,
} from './merge-result-gate';
import { MergeNotCompletedError } from './merge-result-error';

describe('gateMergeResult', () => {
  it('returns clean for merged:true, branchDeleted:true', () => {
    const result: MergePullRequestResult = {
      merged: true,
      sha: 's1',
      branchDeleted: true,
    };
    expect(gateMergeResult(result)).toEqual({ kind: 'clean' });
  });

  it('returns clean for merged:true when branch delete was not requested (no branchDeleteError key)', () => {
    // The server omits `branchDeleteError` when the user did not ask for
    // a delete (deleteBranch: false) or when the head is cross-repo. The
    // sheet should NOT show the partial-success banner in those cases.
    const result: MergePullRequestResult = {
      merged: true,
      sha: 's1',
      branchDeleted: false,
    };
    expect(gateMergeResult(result)).toEqual({ kind: 'clean' });
  });

  it('returns partial for merged:true + branchDeleteError (banner required)', () => {
    const result: MergePullRequestResult = {
      merged: true,
      sha: 's1',
      branchDeleted: false,
      branchDeleteError: 'Reference does not exist',
    };
    expect(gateMergeResult(result)).toEqual({
      kind: 'partial',
      reason: 'Reference does not exist',
    });
  });

  it('returns incomplete for merged:false (the bug the slice fixes)', () => {
    // The first branch of the server returns `merged: boolean`, so the
    // narrowest object literal we can write that matches is the
    // merged:false variant. The gate must not let this through.
    const result: MergePullRequestResult = {
      merged: false,
      sha: 's1',
      branchDeleted: false,
    };
    expect(gateMergeResult(result)).toEqual({ kind: 'incomplete' });
  });
});

describe('assertMergeResult', () => {
  it('returns the clean gate for a clean merge', () => {
    const result: MergePullRequestResult = {
      merged: true,
      sha: 's1',
      branchDeleted: true,
    };
    expect(assertMergeResult(result)).toEqual({ kind: 'clean' });
  });

  it('returns the partial gate (no throw) for a merged + branch-delete-failed result', () => {
    const result: MergePullRequestResult = {
      merged: true,
      sha: 's1',
      branchDeleted: false,
      branchDeleteError: '422 Reference does not exist',
    };
    expect(assertMergeResult(result)).toEqual({
      kind: 'partial',
      reason: '422 Reference does not exist',
    });
  });

  it('throws MergeNotCompletedError for merged:false and the error classifies as RETRYABLE', () => {
    const result: MergePullRequestResult = {
      merged: false,
      sha: 's1',
      branchDeleted: false,
    };

    let thrown: unknown = null;
    try {
      assertMergeResult(result);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MergeNotCompletedError);
    expect((thrown as MergeNotCompletedError).sha).toBe('s1');
    // The whole point of the typed error: it must NOT be classified as
    // a terminal bad-request, because the submit button is enabled in
    // the retryable branch and disabled in the bad-request branch.
    expect(classifyPrReviewMutationError(thrown)).toEqual({ kind: 'retryable' });
  });
});
