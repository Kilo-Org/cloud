import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import {
  enabledStoredByokKeys,
  type StoredByokKeys,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  claudeBillingLinkTakesRequests,
  resolveClaudeBillingModel,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/routing';
import {
  getOpenAiChatGptByokModelIds,
  openAiChatGptOwnerCandidates,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { resolveModelProviderAccess } from '@kilocode/web-shared/lib/ai-gateway/model-provider-access';
import type { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import {
  getIgnoredProviders,
  withIgnoredProviders,
} from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { createDirectByokReferenceResolver } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getRequestIgnoredVercelProviderIds } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  classifyRequestedModel,
  isKeyPlanStep,
  planRoutes,
} from '@kilocode/web-shared/lib/ai-gateway/providers/route-plan';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { canRouteToVercelInRegion } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/** What a request routes under, as far as an organization's inference region is concerned. */
export type InferenceRegionRouting = {
  region: OrganizationDataRegion;
  /** The request's API, or null when the candidates are named before the request exists. */
  apiKind: GatewayChatApiKind | null;
  policy: EffectiveOrganizationModelPolicy | null;
  settings: OrganizationSettings | undefined;
  /** The request's provider object, with the organization's privacy settings applied. */
  requestProvider: OpenRouterProviderConfig | undefined;
  effectivePrivacy: ReturnType<typeof getEffectiveProviderPrivacy>;
  isNonTrialEnterprise: () => Promise<boolean>;
  /** `botId` marks a service run, which may use the organization's shared ChatGPT connection. */
  caller: { userId: string; organizationId: string; botId?: string };
  /**
   * The caller's stored keys, or null when no route the caller pays for may serve the candidates:
   * no key, ChatGPT connection or Claude link.
   */
  loadStoredByokKeys: (() => Promise<StoredByokKeys>) | null;
};

/**
 * Whether routing serves the catalog model in the region: Kilo's route pinned to it, under the
 * provider settings the request would route with, or else one of the caller's keys, which the
 * region exempts (see `getGatewaySettingsRefusal`). Only routes that honor an inference region
 * pin Kilo's route; extend `canRouteToVercelInRegion`'s caller here when another upstream does.
 */
async function isCatalogModelServableInRegion(
  routing: InferenceRegionRouting,
  model: string
): Promise<boolean> {
  const { policy, loadStoredByokKeys } = routing;
  const access = await resolveModelProviderAccess({
    model,
    groupPolicy: policy,
    settings: routing.settings,
    requestProvider: routing.requestProvider,
    effectivePrivacy: routing.effectivePrivacy,
  });
  if (access.providerPreferencesExhausted) return false;
  const routingConfig = access.effectiveProviderConfig ?? routing.requestProvider;
  const kiloIgnoredProviders = getIgnoredProviders(model, await routing.isNonTrialEnterprise());
  if (
    await canRouteToVercelInRegion(
      model,
      withIgnoredProviders(routingConfig, kiloIgnoredProviders),
      routing.region
    )
  ) {
    return true;
  }
  if (!loadStoredByokKeys) return false;
  const plan = await planRoutes({
    requestedModel: model,
    apiKind: routing.apiKind ?? 'chat_completions',
    loadKeys: async () => (await loadStoredByokKeys()).keys,
    isDirectByokProviderAllowed: async policyProviderId =>
      !policy || (await isModelAllowedForProviderKey(policy, model, policyProviderId)),
    getAllowedProviders: async () => access.allowedProviders,
    getRoutingProviderConfig: async () => routingConfig,
    requestIgnoredProviders: getRequestIgnoredVercelProviderIds(routing.requestProvider),
  });
  // Without the request's API, a key that serves the model over any API counts.
  return plan.some(
    step =>
      isKeyPlanStep(step) &&
      (step.decision === 'serves' ||
        (routing.apiKind === null && step.decision === 'unsupported-api-kind'))
  );
}

/**
 * Whether the region leaves the candidate servable. A custom LLM's route never pins a region. A
 * provider model id the caller's key serves is the caller's own route, and with no usable key it
 * fails whatever the region, so only a catalog-mode key's rewrite to a catalog id matters.
 */
async function isCandidateServableInRegion(
  routing: InferenceRegionRouting,
  modelId: string
): Promise<boolean> {
  const requested = await classifyRequestedModel(modelId);
  if (requested.kind === 'custom-llm') return false;
  if (requested.kind === 'direct-byok-model' && routing.loadStoredByokKeys) {
    const enabledKeys = enabledStoredByokKeys(await routing.loadStoredByokKeys());
    if (enabledKeys.some(key => key.providerId === requested.provider.id)) {
      const resolved = await createDirectByokReferenceResolver(enabledKeys)(modelId);
      if (resolved === null || resolved === modelId) return true;
      return isCatalogModelServableInRegion(routing, resolved);
    }
  }
  return isCatalogModelServableInRegion(routing, modelId);
}

/**
 * The candidates an organization's inference region rules out: those routing would refuse only
 * because of the region. Auto routing denies them so it never picks a model the request then fails
 * on. Candidates that fail for other reasons are left to the policy checks that cover them.
 */
export async function inferenceRegionIneligibleCandidates(
  routing: InferenceRegionRouting,
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  const candidates = [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const servable = await Promise.all(
    candidates.map(modelId => isCandidateServableInRegion(routing, modelId))
  );
  const ineligible = candidates.filter((_modelId, index) => !servable[index]);
  if (ineligible.length === 0 || !routing.loadStoredByokKeys) return ineligible;
  const servedByConnection = await candidatesServedByConnection(routing, ineligible);
  return ineligible.filter(modelId => !servedByConnection.has(modelId));
}

/**
 * The candidates the caller's ChatGPT connection or Claude link takes, which the region exempts like
 * a key. A Claude link takes every Claude request, serving it or failing it, so the region never
 * decides those either way.
 */
async function candidatesServedByConnection(
  routing: InferenceRegionRouting,
  candidateIds: string[]
): Promise<ReadonlySet<string>> {
  const { userId, organizationId, botId } = routing.caller;
  const [chatGptModelIds, claudeLinkTakesRequests] = await Promise.all([
    // ChatGPT serves only Responses requests; a CLI decision does not know its API yet. Routing
    // tries each connection the caller may use, so any of them serving a model counts.
    routing.apiKind === 'responses' || routing.apiKind === null
      ? Promise.all(
          openAiChatGptOwnerCandidates({ userId, organizationId, botId }).map(owner =>
            getOpenAiChatGptByokModelIds(owner, candidateIds)
          )
        )
      : [],
    claudeBillingLinkTakesRequests({ userId, organizationId }),
  ]);
  const served = new Set(chatGptModelIds.flatMap(modelIds => [...(modelIds ?? [])]));
  if (claudeLinkTakesRequests) {
    const claudeModels = await Promise.all(candidateIds.map(resolveClaudeBillingModel));
    candidateIds.forEach((modelId, index) => {
      if (claudeModels[index] !== null) served.add(modelId);
    });
  }
  return served;
}
