'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useAdminCreditManagementPermission() {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.admin.getPermissions.queryOptions(undefined, {
      staleTime: 0,
      refetchOnWindowFocus: true,
    })
  );

  return {
    ...query,
    canManageCredits: query.isSuccess && query.data.canManageCredits === true,
  };
}
