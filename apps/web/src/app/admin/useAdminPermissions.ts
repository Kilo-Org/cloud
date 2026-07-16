'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

type AdminPermissionData = {
  isSuperadmin: boolean;
  canViewSessions: boolean;
  canManageCredits: boolean;
};

export function deriveAdminPermissions(
  enabled: boolean,
  query: { isSuccess: boolean; isFetching?: boolean; data?: AdminPermissionData }
) {
  if (!enabled || !query.isSuccess || query.data === undefined) {
    return {
      isPermissionResolved: false,
      isSuperadmin: false,
      canViewSessions: false,
      canManageCredits: false,
    };
  }

  return {
    isPermissionResolved: true,
    isSuperadmin: query.data.isSuperadmin,
    canViewSessions: query.data.canViewSessions,
    canManageCredits: query.data.canManageCredits,
  };
}

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
    ...deriveAdminPermissions(enabled, query),
  };
}
