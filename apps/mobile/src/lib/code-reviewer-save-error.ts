import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

/** What a rejected reviewer-config write shows, and whether it can be sent again. */
export type ReviewerSaveFailure = {
  /** The localized explanation: the server's own reason when the app knows it. */
  message: string;
  /**
   * False when the same request cannot start working by being sent again — a
   * lapsed organization trial, a permission loss, a rejected payload. Those
   * failures keep the explanation and drop the retry action.
   */
  retryable: boolean;
};

/**
 * The explanation for a rejected reviewer-config write (`patchReviewConfig`,
 * the reviewer toggle, a repository-selection delta). The server's sentences
 * are English, so a recognized one is replaced by its localized copy and
 * anything else keeps the caller's own generic line; the raw sentence never
 * reaches a screen.
 *
 * `genericMessage` is the surface's fallback for a failure the app cannot
 * explain — the save line for a config save, the update line for the toggle.
 * `canManageBilling` is the reader's role for the organization trial gate: a
 * billing role gets the copy that offers the plan step, everyone else the copy
 * that names the owner who can. The role defaults to `false`, so a caller that
 * has not resolved it keeps the owner-naming copy.
 */
export function reviewerSaveFailure(
  error: unknown,
  genericMessage: string,
  canManageBilling = false
): ReviewerSaveFailure {
  return {
    message: knownServerErrorMessage(error, canManageBilling) ?? genericMessage,
    retryable: !isTerminalTrpcCode(readTrpcErrorField(error, 'code')),
  };
}
