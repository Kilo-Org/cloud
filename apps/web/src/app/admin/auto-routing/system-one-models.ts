import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { parseAdminResponse } from './admin-fetch';

const SystemOneModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() })),
});

async function fetchSystemOneModels(): Promise<ModelOption[]> {
  const response = await fetch('/admin/api/auto-routing/system-one-models');
  return (await parseAdminResponse(response, SystemOneModelsResponseSchema)).data;
}

/** The classifier model options: System One models only. */
export function useSystemOneModelOptions() {
  return useQuery({
    queryKey: ['auto-routing', 'system-one-models'],
    queryFn: fetchSystemOneModels,
  });
}
