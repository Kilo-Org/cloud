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
import {
  canRouteToVercel,
  canRouteToVercelInRegion,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { getManagedGatewayFromUrl } from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

/**
 * What a request routes under, as far as the organization's gateway settings are concerned. It
 * exists only when they turn OpenRouter off, directly or through an inference region: Kilo then
 * pays only through Vercel, pinned to the region when one is set.
 */
export type GatewaySettingsRouting = {
  /** The inference region, or null when the settings only turn OpenRouter off. */
  region: OrganizationDataRegion | null;
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
 * Whether Kilo's route serves the model under the gateway settings: only Vercel may, under the
 * provider settings the request would route with, and only pinned to the region when one is set.
 * Extend this when another upstream can serve those requests.
 */
async function kiloRouteServes(
  routing: GatewaySettingsRouting,
  model: string,
  provider: OpenRouterProviderConfig | undefined
): Promise<boolean> {
  return routing.region
    ? canRouteToVercelInRegion(model, provider, routing.region)
    : canRouteToVercel(model, provider);
}

/**
 * Whether routing serves the catalog model under the gateway settings: Kilo's route (see
 * `kiloRouteServes`), or else one of the caller's keys, which the settings exempt (see
 * `getGatewaySettingsRefusal`).
 */
async function isCatalogModelServable(
  routing: GatewaySettingsRouting,
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
    await kiloRouteServes(routing, model, withIgnoredProviders(routingConfig, kiloIgnoredProviders))
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
 * Whether the gateway settings leave the candidate servable. A custom LLM's route never pins a
 * region, and with OpenRouter off it is refused only when its upstream is on OpenRouter's domain. A
 * provider model id the caller's key serves is the caller's own route, and with no usable key it
 * fails whatever the settings, so only a catalog-mode key's rewrite to a catalog id matters.
 */
async function isCandidateServable(
  routing: GatewaySettingsRouting,
  modelId: string
): Promise<boolean> {
  const requested = await classifyRequestedModel(modelId);
  if (requested.kind === 'custom-llm') {
    return (
      routing.region === null &&
      getManagedGatewayFromUrl(requested.customLlm.definition.base_url) !== 'openrouter'
    );
  }
  if (requested.kind === 'direct-byok-model' && routing.loadStoredByokKeys) {
    const enabledKeys = enabledStoredByokKeys(await routing.loadStoredByokKeys());
    if (enabledKeys.some(key => key.providerId === requested.provider.id)) {
      const resolved = await createDirectByokReferenceResolver(enabledKeys)(modelId);
      if (resolved === null || resolved === modelId) return true;
      return isCatalogModelServable(routing, resolved);
    }
  }
  return isCatalogModelServable(routing, modelId);
}

/**
 * The candidates the organization's gateway settings rule out: those routing would refuse only
 * because OpenRouter is off or because of the inference region. Auto routing denies them so it
 * never picks a model the request then fails on. Candidates that fail for other reasons are left
 * to the policy checks that cover them.
 */
export async function gatewaySettingsIneligibleCandidates(
  routing: GatewaySettingsRouting,
  candidateIds: ReadonlyArray<string>
): Promise<string[]> {
  const candidates = [...new Set(candidateIds.filter(id => !isVirtualAutoModelId(id)))];
  const servable = await Promise.all(
    candidates.map(modelId => isCandidateServable(routing, modelId))
  );
  const ineligible = candidates.filter((_modelId, index) => !servable[index]);
  if (ineligible.length === 0 || !routing.loadStoredByokKeys) return ineligible;
  const servedByConnection = await candidatesServedByConnection(routing, ineligible);
  return ineligible.filter(modelId => !servedByConnection.has(modelId));
}

/**
 * The candidates the caller's ChatGPT connection or Claude link takes, which the gateway settings
 * exempt like a key. A Claude link takes every Claude request, serving it or failing it, so the
 * settings never decide those either way.
 */
async function candidatesServedByConnection(
  routing: GatewaySettingsRouting,
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
