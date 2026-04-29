'use client';

import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import {
  useOpenRouterModels,
  useOpenRouterModelsAndProviders,
  useOpenRouterProviders,
} from '@/app/api/openrouter/hooks';
import type { OpenRouterProvider } from '@/lib/organizations/organization-types';

export type ConfigurationData = {
  allModelsAllowed: boolean;
  allProvidersEnabled: boolean;
  displayModelDenyList: string[];
  displayProviderAllowList: string[];
  getProviderNames: (slugs: string[]) => string[];
  getModelNames: (modelIds: string[]) => string[];
};

export function useOrganizationConfiguration(organizationId: string) {
  const { data: organizationData, isLoading: orgLoading } =
    useOrganizationWithMembers(organizationId);
  const { data: modelsData, isLoading: modelsLoading } = useOpenRouterModels();
  const { data: providersData, isLoading: providersLoading } = useOpenRouterProviders();
  const { isLoading: providersSnapshotLoading } = useOpenRouterModelsAndProviders();

  const isLoading = orgLoading || modelsLoading || providersLoading || providersSnapshotLoading;

  if (isLoading || !organizationData || !modelsData?.data || !providersData?.data) {
    return {
      isLoading,
      organizationData,
      configurationData: null,
    };
  }

  const settings = organizationData.settings;
  const modelDenyList = settings?.model_deny_list ?? [];
  const providerAllowList =
    settings?.provider_policy_mode === 'allow' ? settings.provider_allow_list : undefined;

  const allModelsAllowed = modelDenyList.length === 0;
  const allProvidersEnabled = providerAllowList === undefined;

  // Get provider names for display
  const getProviderNames = (slugs: string[]) => {
    if (!providersData?.data) return slugs;
    return slugs.map(slug => {
      const provider = providersData.data.find((p: OpenRouterProvider) => p.slug === slug);
      return provider?.displayName || provider?.name || slug;
    });
  };

  // Get model names for display (just use the model IDs as they are already human-readable)
  const getModelNames = (modelIds: string[]) => {
    return modelIds;
  };

  const configurationData: ConfigurationData = {
    allModelsAllowed,
    allProvidersEnabled,
    displayModelDenyList: modelDenyList,
    displayProviderAllowList: providerAllowList ?? [],
    getProviderNames,
    getModelNames,
  };

  return {
    isLoading,
    organizationData,
    configurationData,
  };
}
