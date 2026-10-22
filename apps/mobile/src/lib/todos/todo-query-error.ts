// Pure error-state selector for the to-do list and detail screens.
//
// A denial is not a transient failure: the caller may no longer reach the list
// or item, so it shows the access-denied state and offers no Retry. The retry
// decision is `!isTerminalTrpcCode(code)`, the same rule the organization
// members list uses, so no permanent code carries a refetch that cannot help.

import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

export type TodoQueryErrorView = {
  variant: 'permission' | 'not-found' | 'server';
  showRetry: boolean;
};

export function selectTodoQueryErrorView(error: unknown): TodoQueryErrorView {
  const code = readTrpcErrorField(error, 'code');

  let variant: TodoQueryErrorView['variant'] = 'server';
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    variant = 'permission';
  } else if (code === 'NOT_FOUND') {
    variant = 'not-found';
  }

  return { variant, showRetry: !isTerminalTrpcCode(code) };
}
