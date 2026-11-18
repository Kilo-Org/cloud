'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

const NO_PREFERRED_MODELS: ReadonlyArray<string> = [];

export function usePreferredModels(): ReadonlyArray<string> {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.models.preferred.queryOptions(),
    staleTime: 5 * 60_000,
  });
  return data ?? NO_PREFERRED_MODELS;
}
