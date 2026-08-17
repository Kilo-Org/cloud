// Mobile-side helpers for the PR operation ledger (P1-A-08c). The web router
// admits a `pr`-domain ledger row for each mutation carrying an `operationKey`.
// This module owns the mapping from the server's stable ledger markers onto
// per-surface PR copy. The per-intent key and the raw markers live in
// `@/lib/operation-key`, which every ledgered surface shares.

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
const PR_SURFACE_RETRYABLE_COPY: Record<PrMutationSurface, string> = {
  'create-comment': 'Could not post comment.',
  'submit-review': 'Could not submit review. Check your connection and try again.',
  reply: 'Could not reply.',
  merge: 'Could not merge pull request.',
};

export function isPrOperationAmbiguous(error: unknown): boolean {
  return error instanceof Error && error.message === PR_OPERATION_AMBIGUOUS_MESSAGE;
}

export function isPrOperationPersistenceFailed(error: unknown): boolean {
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
export function mapPrOperationError(error: unknown, surface: PrMutationSurface): unknown {
  if (isOperationInProgress(error)) {
    return new Error(PR_SURFACE_RETRYABLE_COPY[surface]);
  }
  if (isPrOperationAmbiguous(error)) {
    return new Error(PR_OPERATION_AMBIGUOUS_MESSAGE);
  }
  if (isPrOperationPersistenceFailed(error)) {
    return new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
  }
  return error;
}

/** Toast message for a PR mutation error, after ledger-outcome mapping. */
export function prOperationToastMessage(error: unknown, surface: PrMutationSurface): string {
  const mapped = mapPrOperationError(error, surface);
  return mapped instanceof Error ? mapped.message : 'Could not complete this action.';
}
