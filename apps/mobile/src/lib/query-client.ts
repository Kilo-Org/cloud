import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';

export function createKiloAppQueryClient(): QueryClient {
  return new QueryClient({
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
