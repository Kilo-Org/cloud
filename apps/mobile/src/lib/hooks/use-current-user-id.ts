import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

type UseCurrentUserIdOptions = {
  readonly enabled?: boolean;
};

export function useCurrentUserId(options: UseCurrentUserIdOptions = {}): {
  userId: string | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const trpc = useTRPC();
  const { data, isLoading, isError, refetch } = useQuery({
    ...trpc.user.getMe.queryOptions(),
    enabled: options.enabled ?? true,
  });

  return {
    userId: data?.id,
    isLoading,
    isError,
    refetch: () => {
      void refetch();
    },
  };
}
