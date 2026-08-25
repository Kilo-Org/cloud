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

import { i18n } from '@/i18n';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  isPrOperationAmbiguous,
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
  // The ambiguous outcome is NOT the generic retryable copy: the effect may
  // have committed, so the user must verify the PR. Verbatim on both surfaces.
  if (isPrOperationAmbiguous(rawError)) {
    return { kind: 'retryable', message: PR_OPERATION_AMBIGUOUS_MESSAGE };
  }
  // The persistence-failure marker is retry-BLOCKING: the row never became
  // `reconcile_pending`. Use the bad-request kind (no retry CTA) with the
  // honest server copy, not the surface-specific validation copy.
  if (isPrOperationPersistenceFailed(rawError)) {
    return { kind: 'bad-request', message: PR_OPERATION_PERSISTENCE_FAILED_MESSAGE };
  }
  if (classification.kind === 'forbidden') {
    return { kind: 'forbidden', message: classification.message };
  }
  if (classification.kind === 'bad-request') {
    return {
      kind: 'bad-request',
      message:
        surface === 'composer'
          ? i18n.t('prReview.mutationError.commentNotPosted')
          : i18n.t('prReview.mutationError.reviewNotSubmitted'),
    };
  }
  if (classification.kind === 'reconnect') {
    return { kind: 'reconnect', message: i18n.t('prReview.connectionExpired') };
  }
  if (surface === 'submit') {
    return { kind: 'retryable', message: i18n.t('prReview.mutationError.couldNotSubmitReview') };
  }
  const message =
    rawError instanceof Error && rawError.message.length > 0
      ? rawError.message
      : i18n.t('prReview.mutationError.couldNotPostComment');
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
