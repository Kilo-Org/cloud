/**
 * Hook for fetching and filtering organization models
 *
 * Handles fetching organization configuration and available models.
 */

import { useMemo } from 'react';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import type { OrganizationModelAudience } from '@kilocode/app-shared/organizations';

type UseOrganizationModelsReturn = {
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
  defaultModel: string | undefined;
};

/**
 * Fetches and filters models based on organization configuration.
 *
 * If organizationId is provided, the models API applies org access policy.
 *
 * @param organizationId - Optional organization ID to filter models for
 * @param audience - Who runs the selected model; see {@link OrganizationModelAudience}
 */
export function useOrganizationModels(
  organizationId?: string,
  audience: OrganizationModelAudience = 'member'
): UseOrganizationModelsReturn {
  const { data: openRouterModels, isLoading: isLoadingOpenRouter } = useModelSelectorList(
    organizationId,
    true,
    audience
  );

  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return (
      openRouterModels?.data.map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : [],
      })) ?? []
    );
  }, [openRouterModels]);

  return {
    modelOptions,
    isLoadingModels: isLoadingOpenRouter,
    defaultModel: defaultsData?.defaultModel,
  };
}
