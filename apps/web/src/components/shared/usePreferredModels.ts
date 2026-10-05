'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { buildPreferredModels } from '@/lib/ai-gateway/models';

const PREFERRED_MODELS_WITHOUT_FREE_SECTION = buildPreferredModels([]);

export function usePreferredModels(): ReadonlyArray<string> {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.models.preferred.queryOptions(),
    staleTime: 5 * 60_000,
  });
  return data ?? PREFERRED_MODELS_WITHOUT_FREE_SECTION;
}
