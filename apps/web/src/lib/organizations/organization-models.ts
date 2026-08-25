import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import {
  buildAutoModelCatalogEntry,
  getEnhancedOpenRouterModels,
} from '@/lib/ai-gateway/providers/openrouter';
import {
  getEffectiveModelDecision,
  evaluateEffectiveModelAccessPolicy,
} from '@/lib/organizations/effective-model-access.server';
import { listAvailableCustomLlms } from '@/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { getDirectByokModelsForOrganization } from '@/lib/ai-gateway/providers/direct-byok';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import { isOrganizationAutoEnabled } from '@/lib/organizations/organization-auto-model';
import { addUserByokAvailability, getOrganizationByokProviderIds } from '@/lib/ai-gateway/byok';
import { appendLocalFakeDeterministicCatalogModels } from '@/lib/ai-gateway/local-fake-llm';
import { readDb } from '@/lib/drizzle';
import {
  getOrganizationGroupPolicyContext,
  type OrganizationPolicySubject,
} from '@/lib/organizations/organization-group-policy-context.server';

export async function getAvailableModelsForOrganization(
  organizationId: string,
  subject: OrganizationPolicySubject
): Promise<OpenRouterModelsResponse | null> {
  const context = await getOrganizationGroupPolicyContext({ organizationId, subject });
  const organization = context.organization;
  const policy = evaluateEffectiveModelAccessPolicy(context);

  const responseData = await getEnhancedOpenRouterModels();
  const restrictionCandidates = [...responseData.data];

  const filteredModels = [];
  for (const model of restrictionCandidates) {
    if ((await getEffectiveModelDecision(policy, model.id)).allowed) {
      filteredModels.push(model);
    }
  }

  let availableModels = await addUserByokAvailability(
    filteredModels,
    await getOrganizationByokProviderIds(readDb, organizationId)
  );

  if (organization.plan === 'teams' && organization.settings.data_collection === 'deny') {
    availableModels = availableModels.filter(model => model.mayTrainOnYourPrompts !== true);
  }

  if (organization.plan !== 'enterprise' && organization.settings.data_collection !== 'deny') {
    availableModels.push(...(await listAvailableExperimentModels()));
  }

  if (isOrganizationAutoEnabled(organization)) {
    availableModels.push(buildAutoModelCatalogEntry(ORG_AUTO_MODEL));
  }

  availableModels.push(...(await getDirectByokModelsForOrganization(organizationId)));
  availableModels.push(...(await listAvailableCustomLlms(organizationId, context.groupIds)));

  return {
    ...responseData,
    data: appendLocalFakeDeterministicCatalogModels(availableModels),
  };
}
