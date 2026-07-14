import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';

// tRPC error codes that retrying can never fix — surface these immediately
// instead of sitting on a skeleton through the default retry backoff.
const PERMANENT_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
]);

export function createKiloAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          const code = (error as { data?: { code?: string } } | null)?.data?.code;
          if (code !== undefined && PERMANENT_CODES.has(code)) {
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 3000),
      },
    },
    queryCache: new QueryCache({
      onError: error => {
        handleTrpcQueryError(error);
      },
    }),
    mutationCache: new MutationCache({
      onError: error => {
        handleTrpcQueryError(error);
      },
    }),
  });
}

export const queryClient = createKiloAppQueryClient();
