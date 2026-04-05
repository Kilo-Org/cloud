'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type ModelStatsListParams = {
  page: number;
  limit: number;
  sortBy: 'name' | 'openrouterId' | 'createdAt' | 'isActive';
  sortOrder: 'asc' | 'desc';
  search?: string;
  isActive?: '' | 'true' | 'false';
};

export function useModelStatsList(params: ModelStatsListParams) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.modelStats.list.queryOptions(params));
}

type CreateModelInput = {
  openrouterId: string;
  name: string;
  slug?: string;
  aaSlug?: string;
  isActive?: boolean;
};

export function useCreateModel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.modelStats.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [['admin', 'modelStats', 'list']] });
      },
    })
  );
}

type UpdateModelInput = {
  id: string;
  aaSlug?: string | null;
  isActive?: boolean;
  isFeatured?: boolean;
  isStealth?: boolean;
};

export function useUpdateModel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.modelStats.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [['admin', 'modelStats', 'list']] });
      },
    })
  );
}

export function useTriggerStatsUpdate() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.admin.modelStats.triggerSync.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [['admin', 'modelStats', 'list']] });
      },
    })
  );
}

export function useBustModelStatsCache() {
  const trpc = useTRPC();

  return useMutation(trpc.admin.modelStats.bustCache.mutationOptions());
}

export type { CreateModelInput, UpdateModelInput };
