'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

export function useAdminAppBuilderProject(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.appBuilder.get.queryOptions({ id: projectId ?? '' }),
    enabled: Boolean(projectId),
  });
}
