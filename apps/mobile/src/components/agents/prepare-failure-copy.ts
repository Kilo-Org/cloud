import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** The server reasons of a `prepareSession` rejection the reader can act on
 * — a limit, an access denial, or a repository problem. Any other code
 * (internal configuration failures, unknown shapes) or a codeless transport
 * error carries copy the reader cannot act on, so it never reaches the UI. */
type ActionablePrepareErrorCode =
  | 'PAYMENT_REQUIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UNPROCESSABLE_CONTENT';

/** A stable, user-authored refusal: the picked model was retired between
 * selection and create. The reader's fix is to pick another model, so the
 * message is safe to surface even though its code is a generic BAD_REQUEST. */
const MODEL_UNAVAILABLE_MESSAGE = 'Selected model is not available for this cloud agent session';

/**
 * The display copy for a `prepareSession` rejection, classified by the tRPC
 * error code — never by unchecked message text. A user-actionable refusal
 * keeps the server's reason; everything else gets the localized generic line,
 * so an internal configuration string can never reach the reader.
 */
export function prepareFailureMessage(error: unknown, retryable: boolean): string {
  const message = readTrpcErrorField(error, 'message');
  if (!retryable) {
    const code = readTrpcErrorField(error, 'code');
    const actionable: readonly string[] = [
      'PAYMENT_REQUIRED',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'UNPROCESSABLE_CONTENT',
    ] satisfies readonly ActionablePrepareErrorCode[];
    const isActionable = code !== undefined && actionable.includes(code);
    // The model-unavailable refusal rides a generic BAD_REQUEST; its message
    // is a fixed constant the server authors, so matching it exactly cannot
    // leak an internal string while telling the reader to pick another model.
    if ((isActionable || message === MODEL_UNAVAILABLE_MESSAGE) && message) {
      return message;
    }
  }
  return i18n.t('agentChat.newSession.couldNotStartSessionNow');
}
