import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  buildAutoModelCatalogEntry,
  getEnhancedOpenRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import {
  getEffectiveModelDecision,
  evaluateEffectiveModelAccessPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { listAvailableCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { getDirectByokModelsForOrganization } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { ORG_AUTO_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isOrganizationAutoEnabled } from '@kilocode/web-shared/lib/organizations/organization-auto-model';
import {
  addUserByokAvailability,
  getOrganizationByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { tagOpenAiChatGptByokModels } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getEnkryptBenchmarks,
  publishEnkryptModels,
} from '@kilocode/web-shared/lib/model-stats/enkrypt';
import {
  getOrganizationGroupPolicyContext,
  type OrganizationPolicySubject,
} from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';

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

  if (isOrganizationAutoEnabled(organization)) {
    availableModels.push(buildAutoModelCatalogEntry(ORG_AUTO_MODEL));
  }

  availableModels.push(...(await getDirectByokModelsForOrganization(organizationId)));
  availableModels.push(...(await listAvailableCustomLlms(organizationId, context.groupIds)));

  // The ChatGPT connection is personal, so it marks models only for the member
  // whose connection applies to this organization.
  if (subject.type === 'member') {
    availableModels = await tagOpenAiChatGptByokModels(
      { kiloUserId: subject.kiloUserId, organizationId },
      availableModels
    );
  }

  const snapshot = await getEnkryptBenchmarks();
  return {
    ...responseData,
    data: publishEnkryptModels(
      appendLocalFakeDeterministicCatalogModels(availableModels),
      snapshot
    ),
  };
}
