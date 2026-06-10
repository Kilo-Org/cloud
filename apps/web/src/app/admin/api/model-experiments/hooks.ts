'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { PageSize } from '@/types/pagination';

export type ModelExperimentRequestFilters = {
  page: number;
  limit: PageSize;
  experimentId?: string;
  variantId?: string;
  clientRequestId?: string;
  requestKind?: 'chat_completions' | 'messages' | 'responses';
  outcome: 'all' | 'success' | 'error';
  bodyState: 'all' | 'available' | 'truncated' | 'failed' | 'deleted';
};

export function useModelExperiments(includeArchived = false) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.modelExperiments.list.queryOptions({ includeArchived }));
}

export function useModelExperiment(id: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.modelExperiments.get.queryOptions({ id: id ?? '' }),
    enabled: id !== null && id.length > 0,
  });
}

export function useModelExperimentRequests(filters: ModelExperimentRequestFilters) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.modelExperiments.listRequests.queryOptions(filters));
}

function useInvalidate() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({
      queryKey: trpc.admin.modelExperiments.list.queryKey(),
    });
    void qc.invalidateQueries({
      queryKey: trpc.admin.modelExperiments.get.queryKey(),
    });
  };
}

export function useCreateExperiment() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.create.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useUpdateExperiment() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.update.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useDeleteExperiment() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.delete.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useActivateExperiment() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.activate.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function usePauseExperiment() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.pause.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useCompleteExperiment() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.complete.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useSetExperimentArchived() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.setArchived.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useAddVariant() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.addVariant.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useRemoveVariant() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.removeVariant.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useUpdateVariantLabel() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.updateVariantLabel.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useSwapVariantVersion() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.swapVariantVersion.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}

export function useRotateApiKey() {
  const trpc = useTRPC();
  const invalidate = useInvalidate();
  return useMutation(
    trpc.admin.modelExperiments.rotateApiKey.mutationOptions({
      onSuccess: () => invalidate(),
    })
  );
}
