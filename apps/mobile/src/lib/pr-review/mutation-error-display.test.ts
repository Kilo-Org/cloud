import { describe, expect, it, vi } from 'vitest';

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  mutationErrorDisplay,
  mutationErrorDisplayFromError,
} from '@/lib/pr-review/mutation-error-display';
import {
  PR_OPERATION_AMBIGUOUS_MESSAGE,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';

// `mutation-error-display` imports the ambiguous-marker constant from the PR
// operation-ledger helpers, which import `expo-crypto` (and transitively
// react-native). Mock it so this pure suite stays node-only, same as the
// other ledger pure tests.
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used-in-pure-tests',
}));

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

  it('shows the verify-before-retry copy inline (no generic retryable message) for an ambiguous submit-review', () => {
    // The ledger's ambiguous outcome means the effect may have committed: the
    // inline error must pass the marker through verbatim — NOT the generic
    // "check your connection" retryable copy — on both surfaces.
    const ambiguous = new Error(PR_OPERATION_AMBIGUOUS_MESSAGE);
    const classification = classifyPrReviewMutationError(ambiguous);
    expect(classification).toEqual({ kind: 'retryable' });
    expect(mutationErrorDisplay('submit', classification, ambiguous)).toEqual({
      kind: 'retryable',
      message: PR_OPERATION_AMBIGUOUS_MESSAGE,
    });
    expect(mutationErrorDisplay('composer', classification, ambiguous)).toEqual({
      kind: 'retryable',
      message: PR_OPERATION_AMBIGUOUS_MESSAGE,
    });
    // The convenience wrapper classifies then selects the same inline copy.
    expect(mutationErrorDisplayFromError('submit', ambiguous)).toEqual({
      kind: 'retryable',
      message: PR_OPERATION_AMBIGUOUS_MESSAGE,
    });
  });

  it('maps the persistence-failure marker to the retry-blocking kind with the honest server copy', () => {
    // The reconcile-pending persistence failure must never offer a retry CTA:
    // it maps to the retry-blocking bad-request kind with the server's own
    // copy (NOT the surface-specific validation copy), on both surfaces.
    const persistenceFailed = new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
    const classification = classifyPrReviewMutationError(persistenceFailed);
    expect(classification).toEqual({ kind: 'retryable' });
    expect(mutationErrorDisplay('composer', classification, persistenceFailed)).toEqual({
      kind: 'bad-request',
      message: PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
    });
    expect(mutationErrorDisplay('submit', classification, persistenceFailed)).toEqual({
      kind: 'bad-request',
      message: PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
    });
    expect(mutationErrorDisplayFromError('submit', persistenceFailed)).toEqual({
      kind: 'bad-request',
      message: PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
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
        "This review can't be submitted as is. The PR may have changed, or you can't review your own pull request.",
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
