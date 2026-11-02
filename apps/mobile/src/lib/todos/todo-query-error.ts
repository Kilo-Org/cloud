// Pure error-state selector for the to-do list and detail screens.
//
// A denial is not a transient failure: the caller may no longer reach the list
// or item, so it shows the access-denied state and offers no Retry. The variant
// comes from the shared tRPC code mapping and the retry decision is
// `!isTerminalTrpcCode(code)`, the same rule the organization and profile lists
// use, so no permanent code carries a refetch that cannot help.

import { type QueryErrorVariant } from '@/components/query-error';
import { isTerminalTrpcCode, readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';

export type TodoQueryErrorView = {
  variant: QueryErrorVariant;
  showRetry: boolean;
};

export function selectTodoQueryErrorView(error: unknown): TodoQueryErrorView {
  const code = readTrpcErrorField(error, 'code');
  return { variant: trpcErrorVariant(error), showRetry: !isTerminalTrpcCode(code) };
}
