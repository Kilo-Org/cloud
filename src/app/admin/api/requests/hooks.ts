'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type ListParams = {
  page: number;
  limit: number;
  sortOrder: 'asc' | 'desc';
  requestId?: string;
  startTime?: string;
  endTime?: string;
  query?: string;
};

export function useAdminRequests(params: ListParams) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.requests.list.queryOptions(params));
}

export function useAdminRequestById(id: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.requests.getById.queryOptions({ id: id ?? '' }),
    enabled: !!id,
  });
}
