import type { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';

export function logTRPCError(
  error: TRPCError,
  hint?: Parameters<typeof captureException>[1]
): void {
  console.error('tRPC Error occurred:', error);

  if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') {
    return;
  }

  captureException(error, hint);
}
