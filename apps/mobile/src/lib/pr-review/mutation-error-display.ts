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
} from '@/lib/pr-review/merge/pr-operation-ledger';

type MutationErrorDisplaySurface = 'composer' | 'submit';

type MutationErrorDisplayKind = 'retryable' | 'bad-request' | 'forbidden' | 'reconnect';

type MutationErrorDisplay = {
  kind: MutationErrorDisplayKind;
  message: string;
};

type Classification = ReturnType<typeof classifyPrReviewMutationError>;

type MutationErrorDisplayOptions = {
  /** The raw thrown error, used for the retryable composer copy. */
  readonly rawError?: unknown;
  /**
   * The connected provider's noun, already translated (s6f): on the submit
   * surface a bad-request then reads "The merge request may have changed, or
   * you can't review your own merge request." instead of the hardcoded
   * GitHub copy. Absent (GitHub), the exact pre-s6 copy stays.
   */
  readonly term?: string;
};

/**
 * The bad-request inline copy per surface. The submit surface words the
 * rejection after the connected provider when a term rides (s6f).
 */
function badRequestMessage(surface: MutationErrorDisplaySurface, term?: string): string {
  if (surface === 'composer') {
    return i18n.t('prReview.mutationError.commentNotPosted');
  }
  return term === undefined
    ? i18n.t('prReview.mutationError.reviewNotSubmitted')
    : i18n.t('prReview.mutationError.reviewNotSubmittedTerm', { term });
}

/**
 * Maps a mutation classification (and optional raw error for retryable
 * composer copy) to the inline message the sheet should show.
 */
export function mutationErrorDisplay(
  surface: MutationErrorDisplaySurface,
  classification: Classification,
  options?: MutationErrorDisplayOptions
): MutationErrorDisplay {
  const rawError = options?.rawError;
  // The ambiguous outcome is NOT the generic retryable copy: the effect may
  // have committed, so the user must verify the PR. Verbatim on both surfaces.
  if (isPrOperationAmbiguous(rawError)) {
    return { kind: 'retryable', message: i18n.t('prReview.operation.ambiguous') };
  }
  // The persistence-failure marker is retry-BLOCKING: the row never became
  // `reconcile_pending`. Use the bad-request kind (no retry CTA) with the
  // honest server copy, not the surface-specific validation copy.
  if (isPrOperationPersistenceFailed(rawError)) {
    return { kind: 'bad-request', message: i18n.t('prReview.operation.persistenceFailed') };
  }
  if (classification.kind === 'forbidden') {
    return { kind: 'forbidden', message: classification.message };
  }
  if (classification.kind === 'bad-request') {
    return { kind: 'bad-request', message: badRequestMessage(surface, options?.term) };
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
  error: unknown,
  term?: string
): MutationErrorDisplay {
  return mutationErrorDisplay(surface, classifyPrReviewMutationError(error), {
    rawError: error,
    term,
  });
}
