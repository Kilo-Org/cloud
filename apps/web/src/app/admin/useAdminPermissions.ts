'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useAdminPermissions(enabled = true) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.admin.getPermissions.queryOptions(undefined, {
      staleTime: 0,
      refetchOnWindowFocus: true,
    }),
    enabled,
  });

  return {
    ...query,
    isPermissionResolved: enabled && query.isSuccess && !query.isFetching,
    isSuperadmin:
      enabled && query.isSuccess && !query.isFetching && query.data.isSuperadmin === true,
    canViewSessions:
      enabled && query.isSuccess && !query.isFetching && query.data.canViewSessions === true,
    canManageCredits:
      enabled && query.isSuccess && !query.isFetching && query.data.canManageCredits === true,
  };
}
