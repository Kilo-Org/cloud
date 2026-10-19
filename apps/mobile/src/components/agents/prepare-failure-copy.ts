import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** The server reason of a `prepareSession` rejection the reader can act on —
 * a limit, an access denial, or a repository problem. Any other code
 * (internal configuration failures, unknown shapes) or a codeless transport
 * error carries copy the reader cannot act on, so it never reaches the UI. */
type ActionablePrepareErrorCode =
  | 'PAYMENT_REQUIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UNPROCESSABLE_CONTENT';

/**
 * The display copy for a `prepareSession` rejection, classified by the tRPC
 * error code — never by the message text. A user-actionable refusal keeps the
 * server's reason; everything else gets the localized generic line, so an
 * internal configuration string can never reach the reader.
 */
export function prepareFailureMessage(error: unknown, retryable: boolean): string {
  const code = readTrpcErrorField(error, 'code');
  const actionable: readonly string[] = [
    'PAYMENT_REQUIRED',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'UNPROCESSABLE_CONTENT',
  ] satisfies readonly ActionablePrepareErrorCode[];
  const isActionable = code !== undefined && actionable.includes(code);
  const message = !retryable && isActionable ? readTrpcErrorField(error, 'message') : undefined;
  if (message) {
    return message;
  }
  return i18n.t('agentChat.newSession.couldNotStartSessionNow');
}
