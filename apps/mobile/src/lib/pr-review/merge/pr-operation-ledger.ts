// Mobile-side helpers for the PR operation ledger (P1-A-08c).
//
// The web router admits a `pr`-domain ledger row for each mutation that
// carries an `operationKey`. This module owns two concerns for the hooks:
//
//  1. `useHoistedOperationKey` — one key per user intent, hoisted at the hook
//     mount (or first submit) so retries of the SAME intent reuse the key,
//     and regenerated after a success or a terminal (non-retryable) failure
//     so the next submit is a fresh intent. The caller passes an intent
//     fingerprint (derived from every intent-defining mutation input); when
//     the fingerprint changes (the user edited the comment body, review
//     contents, reply text, merge method/message, or another intent input),
//     the stored key is rotated so a changed intent NEVER rides the old
//     key and cannot replay the previous intent's canonical ledger result.
//
//  2. Error mapping — the server signals two ledger outcomes with stable
//     CONFLICT messages: `operation_in_progress` (a same-key duplicate is
//     already in flight or being reconciled) and the ambiguous copy (the
//     effect may have committed; the user must verify the PR before
//     retrying). The hooks map these onto the existing per-surface retryable
//     copy so the inline error boxes and toasts keep their established
//     wording and the retry affordance stays untouched.

import * as Crypto from 'expo-crypto';
import { useRef } from 'react';

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

export const PR_OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
export const PR_OPERATION_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the PR before retrying.";
// The server's distinct persistence failure: the ambiguous outcome could not
// be recorded as `reconcile_pending`, so the ambiguous "check before retrying"
// promise (same-key retries dedupe/reconcile) does NOT hold. The same key must
// never be retried against a row that is still `admitted`, so this marker is
// treated as non-retryable and rotates the key like any terminal failure.
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

export function isPrOperationInProgress(error: unknown): boolean {
  return error instanceof Error && error.message === PR_OPERATION_IN_PROGRESS_MESSAGE;
}

export function isPrOperationAmbiguous(error: unknown): boolean {
  return error instanceof Error && error.message === PR_OPERATION_AMBIGUOUS_MESSAGE;
}

export function isPrOperationPersistenceFailed(error: unknown): boolean {
  return error instanceof Error && error.message === PR_OPERATION_PERSISTENCE_FAILED_MESSAGE;
}

/**
 * True when the failure is retryable, so the operation key must be KEPT for
 * the next submit (the ledger dedupes / reconciles the same-key retry instead
 * of re-executing the write). Non-retryable failures (bad-request, forbidden,
 * reconnect, and the ledger persistence-failure marker) end the intent: the
 * next submit is a fresh intent with a fresh key, otherwise a same-key retry
 * would replay a settled `failed` row or hit an admitted row that never became
 * `reconcile_pending`.
 */
export function isPrMutationRetryable(error: unknown): boolean {
  if (isPrOperationPersistenceFailed(error)) {
    return false;
  }
  return classifyPrReviewMutationError(error).kind === 'retryable';
}

/**
 * Maps the ledger outcome markers onto their display copy. `operation_in_progress`
 * becomes the surface's existing retryable message; the ambiguous outcome becomes the
 * "verify the PR before retrying" copy (no new CTA); the persistence-failure marker
 * becomes the terminal "could not record" copy (no retry CTA — the same key must not
 * be retried). All other errors pass through unchanged so the existing classification
 * (bad-request / forbidden / reconnect / raw retryable message) keeps its current
 * behavior.
 */
export function mapPrOperationError(error: unknown, surface: PrMutationSurface): unknown {
  if (isPrOperationInProgress(error)) {
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

/**
 * Hoists one operation key per intent. `getKey(fingerprint)` returns a stable
 * key across retries of the SAME intent fingerprint and rotates the key the
 * moment the fingerprint changes, so a changed intent (edited body, new
 * review contents, different merge method/message, …) becomes a fresh intent
 * with a fresh key instead of replaying the previous intent's canonical
 * result. `rotateKey()` regenerates the key for the next fresh intent (after
 * a success or a terminal failure). The key is created lazily so hooks that
 * never submit do not burn UUIDs.
 */
export function useHoistedOperationKey(): {
  getKey: (fingerprint: string) => string;
  rotateKey: () => void;
} {
  const keyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const getKey = (fingerprint: string) => {
    if (keyRef.current !== null && keyRef.current.fingerprint !== fingerprint) {
      keyRef.current = null;
    }
    keyRef.current ??= { fingerprint, key: Crypto.randomUUID() };
    return keyRef.current.key;
  };
  const rotateKey = () => {
    keyRef.current = null;
  };
  return { getKey, rotateKey };
}
