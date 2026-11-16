// Pure error-state selector for the usage screen's sections.
//
// A permission loss or a missing resource means the server did answer, so those
// permanent states win over connectivity: a paused query cannot explain a 403.
// Otherwise a paused query presents the offline state, and the rest keeps the
// shared tRPC mapping — one warehouse-failure state and one slow-response
// state. Retry is offered only for codes a second attempt can satisfy, so no
// terminal code shows a button that cannot help.

import { type QueryErrorVariant } from '@/components/query-error';
import { isTerminalTrpcCode, readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';

export type UsageErrorView = {
  variant: QueryErrorVariant;
  showRetry: boolean;
};

export function selectUsageErrorView(error: unknown, paused: boolean): UsageErrorView {
  const variant = trpcErrorVariant(error);
  const showRetry = !isTerminalTrpcCode(readTrpcErrorField(error, 'code'));
  if (variant === 'permission' || variant === 'not-found') {
    return { variant, showRetry };
  }
  if (paused) {
    return { variant: 'offline', showRetry };
  }
  return { variant, showRetry };
}
