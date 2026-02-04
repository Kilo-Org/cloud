import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  OpenRouterModelsResponse,
  OpenRouterProvidersResponse,
} from '@/lib/organizations/organization-types';
import {
  OpenRouterProvidersResponseSchema,
  OpenRouterModelsResponseSchema,
} from '@/lib/organizations/organization-types';
import {
  NormalizedOpenRouterResponse,
  type OpenRouterModel,
} from '@/lib/providers/openrouter/openrouter-types';
import * as z from 'zod';
import {
  KILO_AUTO_MODEL_CONTEXT_LENGTH,
  KILO_AUTO_MODEL_DESCRIPTION,
  KILO_AUTO_MODEL_ID,
  KILO_AUTO_MODEL_NAME,
} from '@/lib/kilo-auto-model';

interface OpenRouterProvider {
  name: string;
  displayName: string;
  slug: string;
  baseUrl: string;
  dataPolicy: {
    training: boolean;
    trainingOpenRouter?: boolean;
    retainsPrompts: boolean;
    canPublish: boolean;
    termsOfServiceURL?: string;
    privacyPolicyURL?: string;
    requiresUserIDs?: boolean;
    retentionDays?: number;
  };
  headquarters?: string;
  datacenters?: string[];
  hasChatCompletions: boolean;
  hasCompletions: boolean;
  isAbortable: boolean;
  moderationRequired: boolean;
  editors: string[];
  owners: string[];
  adapterName: string;
  isMultipartSupported: boolean;
  statusPageUrl: string | null;
  byokEnabled: boolean;
  icon?: {
    url: string;
    className?: string;
  };
  ignoredProviderModels: string[];
  models: OpenRouterModel[];
}

interface OpenRouterData {
  providers: Array<{
    name: string;
    displayName: string;
    slug: string;
    dataPolicy: {
      training: boolean;
      retainsPrompts: boolean;
      canPublish: boolean;
    };
    headquarters?: string;
    datacenters?: string[];
    icon?: {
      url: string;
      className?: string;
    };
    models: OpenRouterModel[];
  }>;
  total_providers: number;
  total_models: number;
  generated_at: string;
}

function buildKiloAutoModel(): OpenRouterModel {
  const epochIso = new Date(0).toISOString();
  return {
    slug: KILO_AUTO_MODEL_ID,
    hf_slug: null,
    updated_at: epochIso,
    created_at: epochIso,
    hf_updated_at: null,
    name: KILO_AUTO_MODEL_NAME,
    short_name: KILO_AUTO_MODEL_NAME,
    author: 'Kilo',
    description: KILO_AUTO_MODEL_DESCRIPTION,
    model_version_group_id: null,
    context_length: KILO_AUTO_MODEL_CONTEXT_LENGTH,
    input_modalities: ['text'],
    output_modalities: ['text'],
    has_text_output: true,
    group: 'other',
    instruct_type: null,
    default_system: null,
    default_stops: [],
    hidden: false,
    router: null,
    warning_message: null,
    permaslug: KILO_AUTO_MODEL_ID,
    reasoning_config: null,
    features: null,
    default_parameters: null,
    endpoint: null,
  };
}

export function useOpenRouterModels() {
  return useQuery<OpenRouterModelsResponse>({
    queryKey: ['openrouter-models'],
    queryFn: async (): Promise<OpenRouterModelsResponse> => {
      const response = await fetch('/api/openrouter/models');
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
      }
      const body = await response.json();
      return OpenRouterModelsResponseSchema.parse(body);
    },
  });
}

export function useOpenRouterProviders() {
  return useQuery<OpenRouterProvidersResponse>({
    queryKey: ['openrouter-providers'],
    queryFn: async (): Promise<OpenRouterProvidersResponse> => {
      const response = await fetch('/api/openrouter/providers');
      if (!response.ok) {
        throw new Error(`Failed to fetch providers: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      return OpenRouterProvidersResponseSchema.parse(data);
    },
  });
}

async function parseModelsByProviderBackupData() {
  return NormalizedOpenRouterResponse.parse(
    (await import('@/data/openrouter-models-by-provider-backup.json')).default
  );
}

export function useOpenRouterModelsAndProviders() {
  const query = useQuery({
    queryKey: ['openrouter-models-and-providers'],
    queryFn: async (): Promise<OpenRouterData> => {
      const response = await fetch('/api/openrouter/models-by-provider');
      if (!response.ok) {
        console.error(`Failed to fetch: ${response.status} ${response.statusText}`);
        return await parseModelsByProviderBackupData();
      }
      const parsedResponse = NormalizedOpenRouterResponse.safeParse(await response.json());
      if (!parsedResponse.success) {
        console.error('Failed to parse response', z.prettifyError(parsedResponse.error));
        return await parseModelsByProviderBackupData();
      }
      return parsedResponse.data;
    },
  });

  // Extract providers and models from the simplified structure
  const providers = useMemo((): OpenRouterProvider[] => {
    if (!query.data) return [];

    // Convert the simplified provider structure to the expected OpenRouterProvider format
    return query.data.providers.map(provider => ({
      name: provider.name,
      displayName: provider.displayName,
      slug: provider.slug,
      baseUrl: '', // Not needed for UI, but required by interface
      dataPolicy: provider.dataPolicy,
      headquarters: provider.headquarters,
      datacenters: provider.datacenters,
      hasChatCompletions: true, // Default values for fields not needed by UI
      hasCompletions: false,
      isAbortable: false,
      moderationRequired: false,
      editors: [],
      owners: [],
      adapterName: '',
      isMultipartSupported: false,
      statusPageUrl: null,
      byokEnabled: false,
      icon: provider.icon,
      ignoredProviderModels: [],
      models: provider.models, // Include all models, filtering will happen in the UI hook
    }));
  }, [query.data]);

  // Extract all models from all providers for backward compatibility (only models with endpoints)
  const models = useMemo((): OpenRouterModel[] => {
    if (!query.data) return [];

    // A model can be offered by multiple providers. For consumers that just want a list of
    // selectable model ids, dedupe by model slug.
    const modelBySlug = new Map<string, OpenRouterModel>();
    for (const provider of query.data.providers) {
      for (const model of provider.models) {
        if (!model.endpoint) continue;
        if (!modelBySlug.has(model.slug)) {
          modelBySlug.set(model.slug, model);
        }
      }
    }

    const modelsWithEndpoints = [...modelBySlug.values()];
    const hasAutoAlready = modelsWithEndpoints.some(model => model.slug === KILO_AUTO_MODEL_ID);
    return hasAutoAlready ? modelsWithEndpoints : [buildKiloAutoModel(), ...modelsWithEndpoints];
  }, [query.data]);

  return {
    models,
    providers,
    isLoading: query.isLoading,
    error: query.error,
  };
}
