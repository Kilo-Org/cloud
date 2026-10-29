import { i18n } from '@/i18n';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

/** What a rejected reviewer-config save shows, and whether it can be sent again. */
export type ReviewerConfigSaveFailure = {
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
 * The explanation for a rejected `patchReviewConfig` save. The server's
 * sentences are English, so a recognized one is replaced by its localized
 * copy (`common.organizationTrialEnded` for the organization trial gate) and
 * anything else keeps the generic save line; the raw sentence never reaches a
 * screen.
 */
export function reviewerConfigSaveFailure(error: unknown): ReviewerConfigSaveFailure {
  return {
    message: knownServerErrorMessage(error) ?? i18n.t('codeReviewer.configSaveFailed'),
    retryable: !isTerminalTrpcCode(readTrpcErrorField(error, 'code')),
  };
}
