// Pure error-state selector for the usage screen's sections.
//
// A permission loss or a missing resource means the server did answer, so those
// permanent states come first, and every permanent refusal ends without Retry:
// no terminal code shows a button that cannot help. The rest keeps the shared
// tRPC mapping — one warehouse-failure state and one slow-response state.

import { type QueryErrorVariant } from '@/components/query-error';
import { isTerminalTrpcCode, readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';

export type UsageErrorView = {
  variant: QueryErrorVariant;
  showRetry: boolean;
};

export function selectUsageErrorView(error: unknown): UsageErrorView {
  const variant = trpcErrorVariant(error);
  if (variant === 'permission' || variant === 'not-found') {
    return { variant, showRetry: false };
  }
  if (isTerminalTrpcCode(readTrpcErrorField(error, 'code'))) {
    // Any other terminal refusal (a malformed request, an unprocessable read)
    // is permanent: the screen offers no retry control, and the not-found copy
    // says the data cannot be loaded instead of the server copy's "please try
    // again". The profile Overview screen made the same choice for this case.
    return { variant: 'not-found', showRetry: false };
  }
  // Every usage read settles while offline, so a paused status cannot occur
  // here: this is the retryable states — server, timeout, and an error with no
  // code at all.
  return { variant, showRetry: true };
}
