'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';

/**
 * The organization's alerts in bounded cursor pages. The list and the drawer
 * panels share one query key, so an editor reads the same cached rows the list
 * shows and an invalidation refreshes both, which is what makes a stale-version
 * conflict recoverable without a second endpoint.
 */
export function useOrganizationAlertsQuery(organizationId: string) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  return useInfiniteQuery({
    queryKey: trpc.organizations.alerts.list.queryKey({ organizationId }),
    queryFn: ({ pageParam }) =>
      trpcClient.organizations.alerts.list.query({
        organizationId,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
}

export function useInvalidateOrganizationAlerts(): () => Promise<void> {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.organizations.alerts.pathKey() });
  };
}
