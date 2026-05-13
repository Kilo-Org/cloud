import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

export function useCurrentUserId(): {
  userId: string | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const trpc = useTRPC();
  const { data, isLoading, isError } = useQuery(trpc.user.getMe.queryOptions());

  return {
    userId: data?.id,
    isLoading,
    isError,
  };
}
