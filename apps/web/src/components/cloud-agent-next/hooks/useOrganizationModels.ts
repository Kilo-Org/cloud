/**
 * Hook for fetching and filtering organization models
 *
 * Handles fetching organization configuration and available models.
 */

import { useMemo } from 'react';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { appendCloudAgentNextLocalTestModel } from '@/components/cloud-agent-next/model-preferences';
import { buildContextLengthByModelId } from '@/components/cloud-agent-next/model-context-lengths';

type UseOrganizationModelsReturn = {
  /** Models formatted for the ModelCombobox component */
  modelOptions: ModelOption[];
  /** Whether models are still loading */
  isLoadingModels: boolean;
  /** Context windows keyed by exact catalog model ID */
  contextLengthByModelId: ReadonlyMap<string, number>;
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
    return appendCloudAgentNextLocalTestModel(
      openRouterModels?.data.map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
      })) ?? []
    );
  }, [openRouterModels]);

  const contextLengthByModelId = useMemo(
    () => buildContextLengthByModelId(openRouterModels?.data ?? []),
    [openRouterModels]
  );

  return {
    modelOptions,
    isLoadingModels: isLoadingOpenRouter,
    contextLengthByModelId,
    defaultModel: defaultsData?.defaultModel,
  };
}
