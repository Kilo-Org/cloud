import { describe, expect, it } from 'vitest';

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

import { MergeNotCompletedError } from './merge-result-error';

describe('MergeNotCompletedError', () => {
  it('defaults the message to "GitHub did not complete the merge."', () => {
    const error = new MergeNotCompletedError();
    expect(error.message).toBe('GitHub did not complete the merge.');
    expect(error.name).toBe('MergeNotCompletedError');
  });

  it('preserves the optional sha and reason', () => {
    const error = new MergeNotCompletedError({
      sha: 'mergedsha',
      reason: 'not mergeable',
    });
    expect(error.sha).toBe('mergedsha');
    expect(error.reason).toBe('not mergeable');
  });

  it('is classified as RETRYABLE by classifyPrReviewMutationError (NOT terminal bad-request)', () => {
    // The whole point of this typed error: it must not be treated as a
    // tRPC BAD_REQUEST, because the submit button is enabled in the
    // retryable branch and disabled in the bad-request branch. If a
    // future refactor attaches a tRPC code, this test will catch it.
    const error = new MergeNotCompletedError({ reason: 'not mergeable' });

    const classification = classifyPrReviewMutationError(error);
    expect(classification).toEqual({ kind: 'retryable' });
  });
});
