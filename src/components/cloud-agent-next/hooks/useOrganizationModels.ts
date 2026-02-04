/**
 * Hook for fetching and filtering organization models
 *
 * Handles fetching organization configuration, all available models,
 * and filtering based on the organization's allow list.
 */

import { useMemo } from 'react';
import { useOrganizationWithMembers, useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useOpenRouterModelsAndProviders } from '@/app/api/openrouter/hooks';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { isModelAllowedProviderAwareClient } from '@/lib/model-allow.client';

type UseOrganizationModelsReturn = {
  /** Models formatted for the ModelCombobox component */
  modelOptions: ModelOption[];
  /** Whether models are still loading */
  isLoadingModels: boolean;
  /** The organization's default model */
  defaultModel: string | undefined;
};

/**
 * Fetches and filters models based on organization configuration.
 *
 * If organizationId is provided, filters models based on the org's allow list.
 * If no allow list is configured, returns all available models.
 *
 * @param organizationId - Optional organization ID to filter models for
 */
export function useOrganizationModels(organizationId?: string): UseOrganizationModelsReturn {
  // Fetch organization configuration and models
  const { data: organizationData } = useOrganizationWithMembers(organizationId || '', {
    enabled: !!organizationId,
  });
  const {
    models: openRouterModels,
    providers: openRouterProviders,
    isLoading: isLoadingOpenRouter,
  } = useOpenRouterModelsAndProviders();
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  // Get organization's allowed models
  const savedModelAllowList = organizationData?.settings?.model_allow_list || [];
  const allModels = openRouterModels;

  // Filter models based on organization's allow list
  const availableModels = useMemo(() => {
    return savedModelAllowList.length === 0
      ? allModels
      : allModels.filter(model =>
          isModelAllowedProviderAwareClient(model.slug, savedModelAllowList, openRouterProviders)
        );
  }, [allModels, openRouterProviders, savedModelAllowList]);

  // Format models for the combobox
  const modelOptions = useMemo<ModelOption[]>(
    () => availableModels.map(model => ({ id: model.slug, name: model.name })),
    [availableModels]
  );

  return {
    modelOptions,
    isLoadingModels: isLoadingOpenRouter,
    defaultModel: defaultsData?.defaultModel,
  };
}
