import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** tRPC codes whose server message is a refusal the reader can act on — a
 * limit, an access denial, or a repository problem. Any other code (internal
 * configuration failures, unknown shapes) or a codeless transport error
 * carries copy the reader cannot act on, so it never reaches the UI. */
const ACTIONABLE_PREPARE_ERROR_CODES = {
  PAYMENT_REQUIRED: true,
  UNAUTHORIZED: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  UNPROCESSABLE_CONTENT: true,
} as const;

/**
 * The display copy for a `prepareSession` rejection, classified by the tRPC
 * error code — never by the message text. A user-actionable refusal keeps the
 * server's reason; everything else gets the localized generic line, so an
 * internal configuration string can never reach the reader.
 */
export function prepareFailureMessage(error: unknown, retryable: boolean): string {
  if (
    !retryable &&
    ACTIONABLE_PREPARE_ERROR_CODES[readTrpcErrorField(error, 'code') ?? ''] === true
  ) {
    const message = readTrpcErrorField(error, 'message');
    if (message) {
      return message;
    }
  }
  return i18n.t('agentChat.newSession.couldNotStartSessionNow');
}
