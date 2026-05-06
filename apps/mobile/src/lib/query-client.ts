import { QueryCache, QueryClient } from '@tanstack/react-query';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: error => {
      handleTrpcQueryError(error);
    },
  }),
});
