import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

/**
 * Whether the account has any Kilo gateway usage, for the tour's automatic
 * open. `isLoaded` is true only after the server answered: a loading or failed
 * read keeps the gate closed and leaves the launch attempt unspent, so a later
 * success in the same launch can still open the tour for a zero-usage account,
 * and an unknown value never opens it for a used one.
 */
export function useTourGatewayUsage(userId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.user.hasGatewayUsage.queryOptions(),
    enabled: enabled && userId !== undefined,
  });
  return { isLoaded: query.isSuccess, hasUsage: query.data?.hasUsage ?? false };
}
