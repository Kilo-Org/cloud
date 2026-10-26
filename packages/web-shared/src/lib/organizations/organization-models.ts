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
import {
  getDirectByokCatalogModelIds,
  getDirectByokModelsForOrganization,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { ORG_AUTO_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isOrganizationAutoEnabled } from '@kilocode/web-shared/lib/organizations/organization-auto-model';
import {
  addUserByokAvailability,
  getOrganizationByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { tagOpenAiChatGptByokModels } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  openAiChatGptSharedServicesOwner,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import type { OrganizationModelAudience } from '@kilocode/app-shared/organizations';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getEnkryptBenchmarks,
  publishEnkryptModels,
} from '@kilocode/web-shared/lib/model-stats/enkrypt';
import {
  getOrganizationGroupPolicyContext,
  type OrganizationPolicySubject,
} from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';

/**
 * The ChatGPT connection whose models the list marks BYOK-available. A
 * shared-services run is served only from the organization's shared-services
 * connection, never from a member's own, so a member's connection marks models
 * only in that member's own list.
 */
function chatGptByokOwner(
  organizationId: string,
  subject: OrganizationPolicySubject,
  audience: OrganizationModelAudience
): OpenAiChatGptOwner | null {
  if (audience === 'shared_services') return openAiChatGptSharedServicesOwner(organizationId);
  if (subject.type === 'member') return { kiloUserId: subject.kiloUserId, organizationId };
  return null;
}

export async function getAvailableModelsForOrganization(
  organizationId: string,
  subject: OrganizationPolicySubject,
  audience: OrganizationModelAudience = 'member',
  {
    fromDb = db,
    countryCode,
  }: {
    fromDb?: typeof db;
    /** The requester's Vercel IP country; custom LLMs denied there are left out.
     * Null lists every custom LLM, for callers that do not serve a request. */
    countryCode: string | null;
  }
): Promise<OpenRouterModelsResponse | null> {
  const context = await getOrganizationGroupPolicyContext({ organizationId, subject, fromDb });
  const organization = context.organization;
  const policy = evaluateEffectiveModelAccessPolicy(context);

  const responseData = await getEnhancedOpenRouterModels({ countryCode });
  const restrictionCandidates = [...responseData.data];

  const filteredModels = [];
  for (const model of restrictionCandidates) {
    if ((await getEffectiveModelDecision(policy, model.id)).allowed) {
      filteredModels.push(model);
    }
  }

  const [byokProviderIds, directByokCatalogModelIds] = await Promise.all([
    getOrganizationByokProviderIds(readDb, organizationId),
    getDirectByokCatalogModelIds({ type: 'organization', id: organizationId }),
  ]);
  let availableModels = await addUserByokAvailability(
    filteredModels,
    byokProviderIds,
    directByokCatalogModelIds
  );

  if (organization.plan === 'teams' && organization.settings.data_collection === 'deny') {
    availableModels = availableModels.filter(model => model.mayTrainOnYourPrompts !== true);
  }

  if (isOrganizationAutoEnabled(organization)) {
    availableModels.push(buildAutoModelCatalogEntry(ORG_AUTO_MODEL));
  }

  availableModels.push(...(await getDirectByokModelsForOrganization(organizationId)));
  availableModels.push(
    ...(await listAvailableCustomLlms(organizationId, context.groupIds, countryCode))
  );

  const chatGptOwner = chatGptByokOwner(organizationId, subject, audience);
  if (chatGptOwner) {
    availableModels = await tagOpenAiChatGptByokModels(chatGptOwner, availableModels);
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
