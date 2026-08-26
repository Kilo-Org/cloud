// Mobile-side helpers for the PR operation ledger (P1-A-08c). The web router
// admits a `pr`-domain ledger row for each mutation carrying an `operationKey`.
// This module owns the mapping from the server's stable ledger markers onto
// per-surface PR copy. The per-intent key and the raw markers live in
// `@/lib/operation-key`, which every ledgered surface shares.

import { i18n } from '@/i18n';
import { isOperationInProgress } from '@/lib/operation-key';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

export const PR_OPERATION_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the PR before retrying.";
// The ambiguous outcome could not be recorded as `reconcile_pending`, so the
// same key must never be retried: this marker is terminal and rotates the key.
export const PR_OPERATION_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

/** The four PR mutation surfaces; each has its own existing retryable copy. */
export type PrMutationSurface = 'create-comment' | 'submit-review' | 'reply' | 'merge';

// Existing retryable fallback copy per surface (mirrors the sheet/composer
// defaults so an in-progress duplicate reads like a normal retryable failure).
// Values are catalog keys, translated at the use site.
const PR_SURFACE_RETRYABLE_COPY = {
  'create-comment': 'prReview.mutationError.couldNotPostComment',
  'submit-review': 'prReview.mutationError.couldNotSubmitReview',
  reply: 'prReview.operation.couldNotReply',
  merge: 'prReview.merge.couldNotMerge',
} satisfies Record<PrMutationSurface, string>;

/**
 * A ledger marker re-wrapped for display. The kind travels on the error, not in
 * its text, so the sheets can still classify it after the message is
 * translated. The server's own English marker is still matched below.
 */
class PrOperationMarkerError extends Error {
  kind: 'ambiguous' | 'persistence-failed';

  constructor(kind: 'ambiguous' | 'persistence-failed', message: string) {
    super(message);
    this.kind = kind;
  }
}

export function isPrOperationAmbiguous(error: unknown): boolean {
  if (error instanceof PrOperationMarkerError) {
    return error.kind === 'ambiguous';
  }
  return error instanceof Error && error.message === PR_OPERATION_AMBIGUOUS_MESSAGE;
}

export function isPrOperationPersistenceFailed(error: unknown): boolean {
  if (error instanceof PrOperationMarkerError) {
    return error.kind === 'persistence-failed';
  }
  return error instanceof Error && error.message === PR_OPERATION_PERSISTENCE_FAILED_MESSAGE;
}

/**
 * True when the failure is retryable, so the operation key must be KEPT (the
 * ledger dedupes the same-key retry instead of re-executing the write). A
 * non-retryable failure ends the intent: the next submit needs a fresh key.
 */
export function isPrMutationRetryable(error: unknown): boolean {
  if (isPrOperationPersistenceFailed(error)) {
    return false;
  }
  return classifyPrReviewMutationError(error).kind === 'retryable';
}

/**
 * Maps the ledger markers onto display copy: `operation_in_progress` becomes
 * the surface's retryable message; the ambiguous and persistence-failure
 * markers are re-wrapped as plain Errors, which strips the tRPC code so the
 * sheets show the marker copy instead of a code-derived classification. Every
 * other error passes through unchanged.
 */
export function mapPrOperationError<T>(error: T, surface: PrMutationSurface): T | Error {
  if (isOperationInProgress(error)) {
    return new Error(i18n.t(PR_SURFACE_RETRYABLE_COPY[surface]));
  }
  if (isPrOperationAmbiguous(error)) {
    return new PrOperationMarkerError('ambiguous', i18n.t('prReview.operation.ambiguous'));
  }
  if (isPrOperationPersistenceFailed(error)) {
    return new PrOperationMarkerError(
      'persistence-failed',
      i18n.t('prReview.operation.persistenceFailed')
    );
  }
  return error;
}

/** Toast message for a PR mutation error, after ledger-outcome mapping. */
export function prOperationToastMessage(error: unknown, surface: PrMutationSurface): string {
  const mapped = mapPrOperationError(error, surface);
  return mapped instanceof Error
    ? mapped.message
    : i18n.t('prReview.operation.couldNotCompleteAction');
}
