// Pure error-state selector for the usage screen's sections.
//
// A permission loss or a missing resource means the server did answer, so those
// permanent states come first, and every permanent refusal ends without Retry:
// no terminal code shows a button that cannot help. The same holds for an
// unconfigured usage source: the message the server puts on that error
// (`USAGE_SOURCE_NOT_CONFIGURED_MESSAGE`) names a condition no retry can
// change, so it is its own terminal state with explicit copy. The rest keeps
// the shared tRPC mapping — one warehouse-failure state and one slow-response
// state.

import {
  isTerminalTrpcCode,
  isUsageSourceUnavailable,
  readTrpcErrorField,
  trpcErrorVariant,
} from '@/lib/trpc-error';
import { type QueryErrorVariant } from '@/components/query-error';

/**
 * Every state the usage screen's error surface can show. The first four take
 * their copy from `QueryError`'s variant; `unavailable` carries its own
 * title and message because "retrying won't help" is not one variant's copy.
 */
export type UsageErrorState =
  | { name: 'server'; variant: 'server'; showRetry: true }
  | { name: 'timeout'; variant: 'timeout'; showRetry: true }
  | { name: 'permission'; variant: 'permission'; showRetry: false }
  | { name: 'not-found'; variant: 'not-found'; showRetry: false }
  | { name: 'unavailable'; variant: 'server'; showRetry: false };

/**
 * The screen renders `variant` through `QueryError` and offers a retry only
 * when `showRetry` is true, so a terminal state is terminal everywhere the
 * selector's result is used.
 */
export type UsageErrorView = UsageErrorState;

export function selectUsageErrorView(error: unknown): UsageErrorView {
  if (isUsageSourceUnavailable(error)) {
    // The workspace has no usage source configured: retrying cannot create
    // one, so the screen hands the condition its own terminal copy instead of
    // the server state's "please try again".
    return { name: 'unavailable', variant: 'server', showRetry: false };
  }
  const variant = trpcErrorVariant(error);
  if (variant === 'permission') {
    return { name: 'permission', variant, showRetry: false };
  }
  if (variant === 'not-found') {
    return { name: 'not-found', variant, showRetry: false };
  }
  if (isTerminalTrpcCode(readTrpcErrorField(error, 'code'))) {
    // Any other terminal refusal (a malformed request, an unprocessable read)
    // is permanent: the screen offers no retry control, and the not-found copy
    // says the data cannot be loaded instead of the server copy's "please try
    // again". The profile Overview screen made the same choice for this case.
    return { name: 'not-found', variant: 'not-found', showRetry: false };
  }
  // Every usage read settles while offline, so a paused status cannot occur
  // here: this is the retryable states — server, timeout, and an error with no
  // code at all.
  if (variant === 'timeout') {
    return { name: 'timeout', variant, showRetry: true };
  }
  return { name: 'server', variant: 'server', showRetry: true };
}
