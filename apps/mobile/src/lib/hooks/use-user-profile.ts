import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

export function useUserProfile() {
  const trpc = useTRPC();
  return useQuery(trpc.user.getProfile.queryOptions(undefined, { staleTime: 5 * 60_000 }));
}
