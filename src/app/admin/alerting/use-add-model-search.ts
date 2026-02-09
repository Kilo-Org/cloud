'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ModelOption } from '@/app/admin/alerting/types';
import { OpenRouterModelsResponseSchema } from '@/lib/organizations/organization-types';
import { z } from 'zod';

type AddModelSearchResult = {
  models: ModelOption[];
  isLoading: boolean;
  error: unknown;
};

const OpenRouterModelSchema = OpenRouterModelsResponseSchema.shape.data.element;
type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

const modelsSchema = z.union([
  OpenRouterModelsResponseSchema.transform(value => value.data),
  z.array(OpenRouterModelSchema),
]);

export function useAddModelSearch(search: string): AddModelSearchResult {
  const modelsQuery = useQuery({
    queryKey: ['openrouter-models'],
    queryFn: async () => {
      const response = await fetch('/api/openrouter/models');
      const data: unknown = await response.json();
      if (!response.ok) {
        throw new Error('Failed to fetch models');
      }
      const parsed = modelsSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error('Failed to parse models');
      }
      return parsed.data;
    },
  });

  const models = useMemo(() => {
    const list = modelsQuery.data ?? [];
    const mapped: ModelOption[] = list.map((model: OpenRouterModel) => ({
      openrouterId: model.id,
      name: model.name || model.id,
    }));

    if (!search.trim()) return mapped;
    const normalizedSearch = search.toLowerCase();
    return mapped.filter(model => {
      const nameMatch = model.name.toLowerCase().includes(normalizedSearch);
      const idMatch = model.openrouterId.toLowerCase().includes(normalizedSearch);
      return nameMatch || idMatch;
    });
  }, [modelsQuery.data, search]);

  return { models, isLoading: modelsQuery.isLoading, error: modelsQuery.error };
}
