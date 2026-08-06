// Pure selection of the inline mutation-error copy shown in the
// comment-composer and review-submit formSheets. Classification lives in
// `classifyPrReviewMutationError`; this helper maps kind → display message.
//
// FORBIDDEN always passes the server-provided classification.message
// through verbatim (the server already sanitizes it to actionable copy).
// The PR-operation ambiguous marker ("Couldn't confirm — check the PR before
// retrying.") also passes through verbatim on BOTH surfaces: the effect may
// have committed, so the user must verify the PR instead of being shown the
// generic retryable copy.

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  isPrOperationPersistenceFailed,
  PR_OPERATION_AMBIGUOUS_MESSAGE,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type MutationErrorDisplaySurface = 'composer' | 'submit';

type MutationErrorDisplayKind = 'retryable' | 'bad-request' | 'forbidden' | 'reconnect';

type MutationErrorDisplay = {
  kind: MutationErrorDisplayKind;
  message: string;
};

const COMPOSER_BAD_REQUEST =
  "This comment can't be posted. The selected line may have changed, or the PR may have been updated.";
const SUBMIT_BAD_REQUEST =
  "This review can't be submitted as is. The PR may have changed, or you can't review your own pull request.";
const COMPOSER_RETRYABLE_FALLBACK = 'Could not post comment.';
const SUBMIT_RETRYABLE = 'Could not submit review. Check your connection and try again.';
const RECONNECT_MESSAGE = 'GitHub connection expired.';

type Classification = ReturnType<typeof classifyPrReviewMutationError>;

/**
 * Maps a mutation classification (and optional raw error for retryable
 * composer copy) to the inline message the sheet should show.
 */
export function mutationErrorDisplay(
  surface: MutationErrorDisplaySurface,
  classification: Classification,
  rawError?: unknown
): MutationErrorDisplay {
  // The ledger's ambiguous outcome is NOT the generic retryable copy: the
  // effect may have committed, so the user must verify the PR before
  // retrying. Pass it through verbatim on both surfaces.
  if (rawError instanceof Error && rawError.message === PR_OPERATION_AMBIGUOUS_MESSAGE) {
    return { kind: 'retryable', message: PR_OPERATION_AMBIGUOUS_MESSAGE };
  }
  // The ledger's persistence-failure marker is retry-BLOCKING: the row never
  // became `reconcile_pending`, so the same key must not be retried. Map it to
  // the retry-blocking bad-request kind with the honest server copy (not the
  // surface-specific validation copy) so no retry CTA is offered.
  if (isPrOperationPersistenceFailed(rawError)) {
    return { kind: 'bad-request', message: PR_OPERATION_PERSISTENCE_FAILED_MESSAGE };
  }
  if (classification.kind === 'forbidden') {
    return { kind: 'forbidden', message: classification.message };
  }
  if (classification.kind === 'bad-request') {
    return {
      kind: 'bad-request',
      message: surface === 'composer' ? COMPOSER_BAD_REQUEST : SUBMIT_BAD_REQUEST,
    };
  }
  if (classification.kind === 'reconnect') {
    return { kind: 'reconnect', message: RECONNECT_MESSAGE };
  }
  if (surface === 'submit') {
    return { kind: 'retryable', message: SUBMIT_RETRYABLE };
  }
  const message =
    rawError instanceof Error && rawError.message.length > 0
      ? rawError.message
      : COMPOSER_RETRYABLE_FALLBACK;
  return { kind: 'retryable', message };
}

/**
 * Classify + select display in one step. Convenience for call sites that
 * only hold the thrown error.
 */
export function mutationErrorDisplayFromError(
  surface: MutationErrorDisplaySurface,
  error: unknown
): MutationErrorDisplay {
  return mutationErrorDisplay(surface, classifyPrReviewMutationError(error), error);
}
