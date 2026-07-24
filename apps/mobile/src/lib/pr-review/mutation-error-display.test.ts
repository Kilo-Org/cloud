import { describe, expect, it } from 'vitest';

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  mutationErrorDisplay,
  mutationErrorDisplayFromError,
} from '@/lib/pr-review/mutation-error-display';

function makeError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { data: { code } });
  return error;
}

describe('mutationErrorDisplay', () => {
  it('passes the server-provided forbidden message through verbatim on both surfaces', () => {
    const serverMessage =
      "The Kilo GitHub App can't write to this repository. An owner of the repository's organization must install the Kilo app (or approve its updated permissions), then try again.";
    const classification = classifyPrReviewMutationError(makeError('FORBIDDEN', serverMessage));
    expect(mutationErrorDisplay('composer', classification)).toEqual({
      kind: 'forbidden',
      message: serverMessage,
    });
    expect(mutationErrorDisplay('submit', classification)).toEqual({
      kind: 'forbidden',
      message: serverMessage,
    });
  });

  it('uses the surface-specific bad-request inline message', () => {
    const classification = classifyPrReviewMutationError(
      makeError('BAD_REQUEST', 'Cannot approve your own pull request')
    );
    expect(mutationErrorDisplay('composer', classification)).toEqual({
      kind: 'bad-request',
      message:
        "This comment can't be posted. The selected line may have changed, or the PR may have been updated.",
    });
    expect(mutationErrorDisplay('submit', classification)).toEqual({
      kind: 'bad-request',
      message:
        "This review can't be submitted as is. The PR may have changed, or you can't approve your own pull request.",
    });
  });

  it('keeps reconnect copy fixed on both surfaces', () => {
    const classification = classifyPrReviewMutationError(
      makeError('PRECONDITION_FAILED', 'revoked')
    );
    expect(mutationErrorDisplay('composer', classification)).toEqual({
      kind: 'reconnect',
      message: 'GitHub connection expired.',
    });
    expect(mutationErrorDisplay('submit', classification)).toEqual({
      kind: 'reconnect',
      message: 'GitHub connection expired.',
    });
  });

  it('keeps retryable kinds with surface-appropriate messages', () => {
    const networkError = new Error('Network request failed');
    const classification = classifyPrReviewMutationError(networkError);
    expect(mutationErrorDisplay('composer', classification, networkError)).toEqual({
      kind: 'retryable',
      message: 'Network request failed',
    });
    expect(mutationErrorDisplay('composer', classification)).toEqual({
      kind: 'retryable',
      message: 'Could not post comment.',
    });
    expect(mutationErrorDisplay('submit', classification, networkError)).toEqual({
      kind: 'retryable',
      message: 'Could not submit review. Check your connection and try again.',
    });
  });

  it('mutationErrorDisplayFromError classifies then selects', () => {
    const serverMessage = 'Repository was archived so is read-only.';
    expect(
      mutationErrorDisplayFromError('composer', makeError('FORBIDDEN', serverMessage))
    ).toEqual({
      kind: 'forbidden',
      message: serverMessage,
    });
  });
});
