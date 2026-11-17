import { BYOK_PROVIDER_UNAVAILABLE_MESSAGE } from '@kilocode/app-shared/byok-errors';
import { isRetryableTrpcError, readTrpcErrorField } from '@/lib/trpc-error';
import { i18n } from '@/i18n';

/**
 * What one save attempt reports to the surface: a final refusal in the app's own
 * words, or a failure the server has not settled, which keeps its retryable
 * sentence and offers the reader a retry.
 */
export type KeySaveFailure =
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Why the server refused the key, in the app's own words, or `null` when it has
 * not made a final decision and asking again can still succeed. Its message can
 * quote the provider's response, which names things this form does not show and
 * does not translate, so the code decides the copy. The unavailable-provider
 * refusal is the one exception: `FORBIDDEN` alone also covers other denials, so
 * it is recognised by the code and the sentence together, where the sentence is
 * the constant both sides import.
 */
export function refusedKeyMessage(error: unknown): string | null {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'CONFLICT') {
    return i18n.t('profile.providerKeys.keyAlreadyExists');
  }
  if (code === 'PRECONDITION_FAILED') {
    return i18n.t('profile.providerKeys.keyManagedByCodingPlan');
  }
  if (code === 'UNPROCESSABLE_CONTENT') {
    return i18n.t('profile.providerKeys.invalidCredentials');
  }
  // The server refuses a provider it has not opened for this account. Retrying
  // the same request cannot change that verdict, so the copy must not ask for
  // one.
  if (
    code === 'FORBIDDEN' &&
    readTrpcErrorField(error, 'message') === BYOK_PROVIDER_UNAVAILABLE_MESSAGE
  ) {
    return i18n.t('profile.providerKeys.providerUnavailable');
  }
  // Any other verdict the server will repeat for the same value: a duplicate, a
  // malformed credential or another denial. The reader can only fix the value,
  // so the generic store copy asks for that rather than for a retry.
  return isRetryableTrpcError(error) ? null : i18n.t('profile.providerKeys.keyStoreFailed');
}
