// Mobile-side helpers for the PR operation ledger (P1-A-08c). The web router
// admits a `pr`-domain ledger row for each mutation carrying an `operationKey`.
// This module owns the mapping from the server's stable ledger markers onto
// per-surface PR copy. The per-intent key and the raw markers live in
// `@/lib/operation-key` and `@/lib/operation-markers`, which every ledgered
// surface shares.

import { i18n } from '@/i18n';
import { isOperationInProgress } from '@/lib/operation-markers';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { readTrpcErrorField } from '@/lib/trpc-error';

export const PR_OPERATION_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the PR before retrying.";
// The ambiguous outcome could not be recorded as `reconcile_pending`, so the
// same key must never be retried: this marker is terminal and rotates the key.
export const PR_OPERATION_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

/** The PR mutation surfaces; each has its own existing retryable copy. */
export type PrMutationSurface =
  | 'create-comment'
  | 'submit-review'
  | 'reply'
  | 'resolve'
  | 'merge'
  | 'pr-comment';

// Existing retryable fallback copy per surface (mirrors the sheet/composer
// defaults so an in-progress duplicate reads like a normal retryable failure).
// Values are catalog keys, translated at the use site.
const PR_SURFACE_RETRYABLE_COPY = {
  'create-comment': 'prReview.mutationError.couldNotPostComment',
  'submit-review': 'prReview.mutationError.couldNotSubmitReview',
  reply: 'prReview.operation.couldNotReply',
  // A resolve/unresolve toggle is not a reply: a duplicate operation must not
  // tell the reader the thread reply failed. The generic action-failure copy
  // is the existing resolution-neutral string — a new resolution-specific key
  // would need its 86 translations, which belong to the translation slice.
  resolve: 'prReview.operation.couldNotCompleteAction',
  merge: 'prReview.merge.couldNotMerge',
  'pr-comment': 'prReview.mutationError.couldNotPostComment',
} satisfies Record<PrMutationSurface, string>;

/**
 * A ledger marker re-wrapped for display. The kind travels on the error, not in
 * its text, so the sheets can still classify it after the message is
 * translated. The server's own English marker is still matched below.
 */
class PrOperationMarkerError extends Error {
  kind: 'ambiguous' | 'persistence-failed' | 'not-admitted';

  constructor(kind: 'ambiguous' | 'persistence-failed' | 'not-admitted', message: string) {
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
 * The GitHub router's one message for a merge row it has already settled.
 *
 * `reconcileMergePrRow` reads authoritative PR state, settles `head_moved` /
 * `already_closed` with `confirmed_absent` and throws this message, the only
 * place it is thrown (`apps/web/src/routers/github-pr-review-router.ts:829`,
 * `:1481-1488`). The row is over, so the retained key must not survive it. The
 * provider arm settles the same way and throws its own copy instead.
 */
const SETTLED_MERGE_CONFLICT_MESSAGE = 'GitHub reported a conflict for this PR';

/**
 * A head that moved, or a PR that closed, since the surface loaded it: the
 * router settled that ledger row, so the intent is over even though the tRPC
 * code is a `CONFLICT`, and its key must be retired rather than retried.
 *
 * Neither router puts the settled outcome on the wire — both throw
 * `TRPCError({ code: 'CONFLICT', message })` and keep the ledger's `outcomeCode`
 * in the row (`github-pr-review-router.ts:953-960`, `:1488`;
 * `provider-review-router.ts:895-899`) — so the settled marker is the strongest
 * signal there is. It cannot be widened to every `CONFLICT`: the same code
 * carries the live-lease marker (`OPERATION_IN_PROGRESS_MESSAGE`) and the
 * ambiguous reconcile-pending marker (`provider-review-router.ts:477`), where a
 * new key could re-execute a write that may already have committed. A raw
 * conflict, e.g. GitHub's own 405/409 text passed through unchanged
 * (`apps/web/src/lib/github-pr-review/errors.ts:162-163`), therefore keeps its
 * intent.
 */
export function staleHeadRejectionMessage(error: unknown): string | null {
  if (readTrpcErrorField(error, 'code') !== 'CONFLICT') {
    return null;
  }
  const message = error instanceof Error ? error.message : '';
  if (message === SETTLED_MERGE_CONFLICT_MESSAGE) {
    return message;
  }
  return /changed since it was loaded|closed without merging/.test(message) ? message : null;
}

/**
 * The surface refused to admit the write: its retained-key store holds
 * `RETAINED_OPERATION_KEY_LIMIT` unresolved intents, so nothing was sent and
 * there is no ledger row to replay. Only an authoritative retirement frees a
 * slot, so retrying cannot succeed and no surface may offer it.
 */
export function isPrOperationNotAdmitted(error: unknown): boolean {
  return error instanceof PrOperationMarkerError && error.kind === 'not-admitted';
}

/** The refusal a surface throws when its retained-key store is full. */
export function prOperationNotAdmittedError(message: string): Error {
  return new PrOperationMarkerError('not-admitted', message);
}

/**
 * True when the failure is retryable, so the operation key must be KEPT (the
 * ledger dedupes the same-key retry instead of re-executing the write). A
 * non-retryable failure ends the intent: the next submit needs a fresh key.
 */
export function isPrMutationRetryable(error: unknown): boolean {
  if (
    isPrOperationPersistenceFailed(error) ||
    isPrOperationNotAdmitted(error) ||
    staleHeadRejectionMessage(error) !== null
  ) {
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
    return new PrOperationMarkerError('persistence-failed', i18n.t('common.actionNotRecorded'));
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
