import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import {
  buildAutoModelCatalogEntry,
  getEnhancedOpenRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import {
  allowsInferenceProviderUserByok,
  getEffectiveModelDecision,
  evaluateEffectiveModelAccessPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { listAvailableCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { getDirectByokModelsForOrganization } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getAllowedDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/byok/organization-inference-provider-user-byok';
import { ORG_AUTO_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isOrganizationAutoEnabled } from '@kilocode/web-shared/lib/organizations/organization-auto-model';
import {
  addDirectByokCatalogAvailability,
  addUserByokAvailability,
  getOrganizationByokProviderIds,
  hasInferenceProviderUserByokForModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { tagOpenAiChatGptByokModels } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { tagClaudeBillingByokModels } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/byok-models';
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
  // Everything that does not depend on the organization's policy starts with the
  // policy read, so the catalog and BYOK reads overlap it instead of following it.
  const policyPromise = getOrganizationGroupPolicyContext({ organizationId, subject, fromDb }).then(
    context => ({ context, policy: evaluateEffectiveModelAccessPolicy(context) })
  );
  const [
    { context, policy },
    directByokCatalogModelIds,
    responseData,
    byokProviderIds,
    directByokModels,
  ] = await Promise.all([
    policyPromise,
    policyPromise.then(({ policy }) => getAllowedDirectByokCatalogModelIds(organizationId, policy)),
    getEnhancedOpenRouterModels({ countryCode, fromDb }),
    getOrganizationByokProviderIds(readDb, organizationId),
    getDirectByokModelsForOrganization(organizationId),
  ]);
  const organization = context.organization;
  const restrictionCandidates = [...responseData.data];

  const { filteredModels, allowedProvidersByModel } = await applyModelPolicyToCatalog(
    policy,
    restrictionCandidates,
    byokProviderIds,
    directByokCatalogModelIds
  );

  let availableModels = addDirectByokCatalogAvailability(
    await addUserByokAvailability(filteredModels, byokProviderIds, modelId =>
      allowedProvidersByModel.get(modelId)
    ),
    directByokCatalogModelIds
  );

  if (organization.plan === 'teams' && organization.settings.data_collection === 'deny') {
    availableModels = availableModels.filter(model => model.mayTrainOnYourPrompts !== true);
  }

  if (isOrganizationAutoEnabled(organization)) {
    availableModels.push(buildAutoModelCatalogEntry(ORG_AUTO_MODEL));
  }

  availableModels.push(...directByokModels);
  availableModels.push(
    ...(await listAvailableCustomLlms(organizationId, context.groupIds, countryCode))
  );

  availableModels = await tagByokConnectionModels(
    chatGptByokOwner(organizationId, subject, audience),
    organizationId,
    availableModels
  );

  const snapshot = await getEnkryptBenchmarks({ fromDb });
  return {
    ...responseData,
    data: publishEnkryptModels(
      appendLocalFakeDeterministicCatalogModels(availableModels),
      snapshot
    ),
  };
}

/**
 * Marks the models a ChatGPT or Claude billing connection serves as BYOK-available.
 * Each tagger reads its own connection, so they run concurrently and their results
 * are merged by model id.
 */
async function tagByokConnectionModels(
  chatGptOwner: OpenAiChatGptOwner | null,
  organizationId: string,
  models: OpenRouterModel[]
): Promise<OpenRouterModel[]> {
  const byokModelIds = (tagged: OpenRouterModel[]) =>
    tagged.filter(model => model.hasUserByokAvailable === true).map(model => model.id);
  const [chatGptTagged, claudeTagged] = await Promise.all([
    chatGptOwner ? tagOpenAiChatGptByokModels(chatGptOwner, models) : models,
    tagClaudeBillingByokModels({ kind: 'organization', organizationId }, models),
  ]);
  if (chatGptTagged === models && claudeTagged === models) return models;
  const tagged = new Set([...byokModelIds(chatGptTagged), ...byokModelIds(claudeTagged)]);
  return models.map(model =>
    model.hasUserByokAvailable !== true && !tagged.has(model.id)
      ? model
      : { ...model, hasUserByokAvailable: true, isFree: false }
  );
}

/**
 * Applies the effective model policy to the catalog. An unrestricted grant admits
 * every catalog model and records no provider routes, so a per-model decision would
 * only discard its own result: skip the walk and keep the request independent of the
 * catalog width.
 */
async function applyModelPolicyToCatalog(
  policy: EffectiveOrganizationModelPolicy,
  candidates: readonly OpenRouterModel[],
  byokProviderIds: readonly UserByokProviderId[],
  directByokCatalogModelIds: ReadonlySet<string>
): Promise<{
  filteredModels: OpenRouterModel[];
  allowedProvidersByModel: Map<string, ReadonlySet<string>>;
}> {
  const filteredModels: OpenRouterModel[] = [];
  const allowedProvidersByModel = new Map<string, ReadonlySet<string>>();
  if (policy.memberGrant.mode === 'unrestricted') {
    filteredModels.push(...candidates);
    return { filteredModels, allowedProvidersByModel };
  }

  const inferenceCheck = { checked: 0, withoutProviders: 0 };
  for (const model of candidates) {
    const decision = await getEffectiveModelDecision(policy, model.id);
    if (!decision.allowed && !directByokCatalogModelIds.has(model.id)) {
      if (!allowsInferenceProviderUserByok(decision)) {
        continue;
      }
      inferenceCheck.checked += 1;
      const hasInferenceProviderByok = await hasInferenceProviderUserByokForModel(
        model.id,
        byokProviderIds
      );
      if (!hasInferenceProviderByok) {
        inferenceCheck.withoutProviders += 1;
        continue;
      }
    }
    filteredModels.push(model);
    if (decision.eligibleProviderRoutes) {
      allowedProvidersByModel.set(model.id, decision.eligibleProviderRoutes);
    }
  }
  // One record per pass: this loop touches every catalog model, so a per-model
  // record would grow with the catalog rather than with the request.
  if (inferenceCheck.withoutProviders > 0) {
    console.debug(
      `[applyModelPolicyToCatalog] no user byok providers for ${inferenceCheck.withoutProviders} of ${inferenceCheck.checked} models`
    );
  }
  return { filteredModels, allowedProvidersByModel };
}
