import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { createAllowPredicateFromDenyList } from '@/lib/model-allow.server';
import { listAvailableCustomLlms } from '@/lib/custom-llm/listAvailableCustomLlms';
import { getDirectByokModelsForOrganization } from '@/lib/providers/direct-byok';
import { getOrganizationById } from '@/lib/organizations/organizations';

export async function getAvailableModelsForOrganization(
  organizationId: string
): Promise<OpenRouterModelsResponse | null> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    return null;
  }

  let deniedModels: string[] | undefined;
  let deniedProviders: string[] | undefined;

  if (organization.plan === 'enterprise') {
    deniedModels = organization.settings?.model_deny_list;
    deniedProviders = organization.settings?.provider_deny_list;
  }

  const responseData = await getEnhancedOpenRouterModels();

  let filteredModels = responseData.data;
  if (deniedModels?.length || deniedProviders?.length) {
    const isAllowed = createAllowPredicateFromDenyList(deniedModels, deniedProviders);
    const models = [];
    for (const model of responseData.data) {
      if (await isAllowed(model.id)) {
        models.push(model);
      }
    }
    filteredModels = models;
  }

  filteredModels.push(...(await getDirectByokModelsForOrganization(organizationId)));
  filteredModels.push(...(await listAvailableCustomLlms(organizationId)));

  return {
    ...responseData,
    data: filteredModels,
  };
}
