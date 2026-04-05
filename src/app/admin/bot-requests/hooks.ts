'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import type { PageSize } from '@/types/pagination';

export function useWeeklyActiveUsers(days: number) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.botRequests.weeklyActiveUsers.queryOptions({ days }));
}

export function useNewUsersPerDay(days: number) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.botRequests.newUsersPerDay.queryOptions({ days }));
}

export function useDailyUsage(days: number) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.botRequests.dailyUsage.queryOptions({ days }));
}

export function useBotRequestsList(page: number, limit: PageSize) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.botRequests.list.queryOptions({ page, limit }));
}

export function useBotRequestDetail(id: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.botRequests.getById.queryOptions({ id }),
    enabled: Boolean(id),
  });
}
