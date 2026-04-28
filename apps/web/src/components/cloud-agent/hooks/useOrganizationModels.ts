/**
 * Hook for fetching and filtering organization models
 *
 * Handles fetching organization configuration and available models.
 */

import { useMemo } from 'react';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import type { ModelOption } from '@/components/shared/ModelCombobox';

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
 * If organizationId is provided, the models API applies org access policy.
 *
 * @param organizationId - Optional organization ID to filter models for
 */
export function useOrganizationModels(organizationId?: string): UseOrganizationModelsReturn {
  // Fetch models for the model selector
  const { data: openRouterModels, isLoading: isLoadingOpenRouter } =
    useModelSelectorList(organizationId);

  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  // Format models for the combobox
  const modelOptions = useMemo<ModelOption[]>(() => {
    return openRouterModels?.data.map(model => ({ id: model.id, name: model.name })) ?? [];
  }, [openRouterModels]);

  return {
    modelOptions,
    isLoadingModels: isLoadingOpenRouter,
    defaultModel: defaultsData?.defaultModel,
  };
}
