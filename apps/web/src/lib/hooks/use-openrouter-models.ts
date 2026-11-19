import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  OpenRouterModelsResponse,
  OpenRouterProvidersResponse,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import * as z from 'zod';
import { type OrganizationModelAudience } from '@kilocode/app-shared/organizations';
import { useTRPC } from '@/lib/trpc/utils';

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
  isMultipartSupported?: boolean;
  statusPageUrl: string | null;
  byokEnabled: boolean;
  icon?: {
    url: string;
    className?: string;
  };
  ignoredProviderModels: string[];
  /** Kilo never routes to this provider; it only serves an organization's own keys. */
  byokOnly?: boolean;
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
    byokOnly?: true;
    models: OpenRouterModel[];
  }>;
  total_providers: number;
  total_models: number;
  generated_at: string;
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
      const { OpenRouterModelsResponseSchema } =
        await import('@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas');
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
      const { OpenRouterProvidersResponseSchema } =
        await import('@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas');
      return OpenRouterProvidersResponseSchema.parse(data);
    },
  });
}

/**
 * The model list a picker offers, read over tRPC rather than the `/api` REST
 * routes: those authenticate with the web session, and the app shell's session
 * cookie only covers `/app-shell`, so its pages read the same list through
 * `/app-shell/api/trpc`. The query carries an organization id or not, and the
 * procedure answers with that organization's list or the caller's own.
 */
export function useModelSelectorList(
  organizationId: string | undefined,
  enabled = true,
  audience: OrganizationModelAudience = 'member',
  cacheOptions?: { staleTime: number; gcTime: number }
) {
  const trpc = useTRPC();
  const query = useQuery({
    ...cacheOptions,
    ...trpc.models.selectorList.queryOptions({ organizationId, audience }, { enabled }),
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useOpenRouterModelsAndProviders() {
  const query = useQuery({
    queryKey: ['openrouter-models-and-providers'],
    queryFn: async (): Promise<Pick<OpenRouterData, 'providers'>> => {
      const response = await fetch('/api/openrouter/models-by-provider');
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }
      const body: unknown = await response.json();
      const { NormalizedOpenRouterResponse } =
        await import('@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types');
      const parsedResponse = NormalizedOpenRouterResponse.safeParse(body);
      if (!parsedResponse.success) {
        throw new Error('Failed to parse response:\n' + z.prettifyError(parsedResponse.error));
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
      byokOnly: provider.byokOnly,
      models: provider.models, // Include all models, filtering will happen in the UI hook
    }));
  }, [query.data]);

  // Extract all models from all providers for backward compatibility (only models with endpoints)
  const models = useMemo((): OpenRouterModel[] => {
    if (!query.data) return [];

    // A model can be offered by multiple providers. For consumers that just want a list of
    // selectable model ids, dedupe by model slug.
    // BYOK-only providers copy models other providers list, with no Kilo pricing, so they are skipped.
    const modelBySlug = new Map<string, OpenRouterModel>();
    for (const provider of query.data.providers) {
      if (provider.byokOnly) continue;
      for (const model of provider.models) {
        if (!model.endpoint) continue;
        if (!modelBySlug.has(model.slug)) {
          modelBySlug.set(model.slug, model);
        }
      }
    }

    const modelsWithEndpoints = [...modelBySlug.values()];
    return modelsWithEndpoints;
  }, [query.data]);

  return {
    models,
    providers,
    isLoading: query.isLoading,
    error: query.error,
  };
}
