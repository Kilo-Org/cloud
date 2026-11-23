/**
 * The failure a trigger save shows, and whether the same save can clear it.
 *
 * The create and edit surfaces both post a draft, so both read their failure
 * from here: one classification keeps the copy and the Retry decision the same
 * on the two screens.
 */

import { i18n } from '@/i18n';
import { isRetryableTrpcError, readTrpcErrorField, readTrpcServerMessage } from '@/lib/trpc-error';

/**
 * A save that failed, with the sentence the band renders.
 *
 * `retryable` is a failure the same request can plausibly clear (the network,
 * a deadline, a 5xx), so the band offers Retry; `rejected` is the server
 * refusing this input (a taken name, a cron it will not accept, a sandbox
 * rule), where Retry would fail again and the message is what the person acts
 * on.
 */
export type TriggerFormFailure = Readonly<{ kind: 'retryable' | 'rejected'; message: string }>;

/**
 * The failure a trigger save shows.
 *
 * A create's only `CONFLICT` is the name index refusing a trigger name that
 * already exists, and the sentence that refusal carries is English, so the
 * band states the localized copy with the name the form sent. Every other
 * answer speaks for itself only when the server wrote a sentence for the
 * person: `readTrpcServerMessage` refuses a validation envelope, whose text is
 * a serialized issue array, so a transport, framework or validation failure
 * falls back to the copy for its own kind.
 */
export function triggerSaveFailure(
  error: unknown,
  context: Readonly<{ mode: 'create' | 'edit'; name: string }>
): TriggerFormFailure {
  if (readTrpcErrorField(error, 'code') === 'CONFLICT' && context.mode === 'create') {
    return {
      kind: 'rejected',
      message: i18n.t('cloudAgent.triggers.nameTaken', { name: context.name }),
    };
  }
  const kind = isRetryableTrpcError(error) ? 'retryable' : 'rejected';
  const sentence = readTrpcServerMessage(error)?.trim();
  if (sentence !== undefined && sentence !== '') {
    return { kind, message: sentence };
  }
  return {
    kind,
    message: i18n.t(
      kind === 'retryable'
        ? 'cloudAgent.triggers.saveFailedRetry'
        : 'cloudAgent.triggers.saveFailedCheck'
    ),
  };
}
