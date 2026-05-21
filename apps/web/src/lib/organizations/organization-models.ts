import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
  type ModelRestrictions,
} from '@/lib/model-allow.server';
import { listAvailableCustomLlms } from '@/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { getDirectByokModelsForOrganization } from '@/lib/ai-gateway/providers/direct-byok';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';

export async function getAvailableModelsForOrganization(
  organizationId: string
): Promise<OpenRouterModelsResponse | null> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    return null;
  }

  let restrictions: ModelRestrictions = { modelDenyList: [] };

  if (organization.plan === 'enterprise') {
    restrictions = getEffectiveModelRestrictions(organization);
  }

  const responseData = await getEnhancedOpenRouterModels();
  const experimentModels = await listAvailableExperimentModels();
  const restrictionCandidates = responseData.data.concat(experimentModels);

  let filteredModels = restrictionCandidates;
  if (hasActiveModelRestrictions(restrictions)) {
    const isAllowed = createAllowPredicateFromRestrictions(restrictions);
    const models = [];
    for (const model of restrictionCandidates) {
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
