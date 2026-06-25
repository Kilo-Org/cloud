'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useAdminCreditManagementPermission(options?: { enabled?: boolean }) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.admin.getPermissions.queryOptions(undefined, {
      enabled: options?.enabled ?? true,
      staleTime: 0,
      refetchOnWindowFocus: true,
    })
  );

  return {
    ...query,
    canManageCredits: query.isSuccess && query.data.canManageCredits === true,
  };
}
