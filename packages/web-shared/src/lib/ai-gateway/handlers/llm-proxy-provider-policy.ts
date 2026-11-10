import type { NextResponse as NextResponseType } from 'next/server';
import type { User } from '@kilocode/db';
import {
  getProvider,
  type GetProviderProviderResult,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import type { AiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';
import {
  getManagedGatewayFromUrl,
  getOrganizationGatewaySettings,
  isManagedGatewayDisabled,
  NO_ORGANIZATION_GATEWAY_SETTINGS,
  type OrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import { getRuntimeOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { paidUsageRejection } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { getIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { isNonTrialEnterpriseOrganization } from '@kilocode/web-shared/lib/organizations/non-trial-enterprise';
import {
  findDirectByokProvider,
  getDirectByokModel,
  getDirectByokPolicyProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isInferenceProviderUserByok } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { isVercelUserByokProviderAllowed } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { hasBestEffortGuessDataCollectionRequirement } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  allowedInferenceProviders,
  apiKindNotSupportedResponse,
  chatGptReconnectResponse,
  claudeBillingUnavailableResponse,
  dataCollectionRequiredResponse,
  directByokCatalogOnlyMessage,
  directByokCatalogOnlyResponse,
  efficientPoolBlockedResponse,
  getOrganizationProviderPrivacy,
  inferenceProvidersNotAllowedResponse,
  managedGatewayDisabledResponse,
  modelDoesNotExistOnOpenRouterResponse,
  modelNotAllowedResponse,
  organizationAutoConfigurationResponse,
  unavailableModelResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type { BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  isDataCollectionExplicitlyDisallowed,
  type OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { isAnonymousContext, type AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { isUnavailableModel } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { ORG_AUTO_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  allowsInferenceProviderUserByok,
  getEffectiveModelDecision,
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import type { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import type { ValidatedGatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-request';
import type { AdmittedModelResolution } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-model-resolution';

type ProviderPolicyInput = {
  request: ValidatedGatewayRequest;
  /** The resolved model id, lowercased. */
  model: string;
  /** The request's own provider object, before privacy and organization policy replaced it. */
  requestProvider: OpenRouterProviderConfig | undefined;
  customLlm: CustomLlm | null;
  modelResolution: AdmittedModelResolution;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  botId: string | undefined;
  countryCode: string | null;
  boundedSpending: boolean;
  providerMetadataCapture: AiProviderMetadataCapture | undefined;
  effectivePrivacy: ReturnType<typeof getEffectiveProviderPrivacy>;
  balanceAndSettingsPromise: Promise<BalanceAndOrgSettings>;
  organizationGroupPolicyPromise: Promise<EffectiveOrganizationModelPolicy | null>;
};

type ProviderPolicyResult =
  | {
      ok: true;
      providerResult: GetProviderProviderResult;
      isNonTrialEnterprise: boolean;
      dataRegion: OrganizationGatewaySettings['dataRegion'];
    }
  | { ok: false; response: NextResponseType<unknown> };

async function resolveAccessCheck(input: ProviderPolicyInput) {
  const { settings } = await input.balanceAndSettingsPromise;
  const groupPolicy = await input.organizationGroupPolicyPromise;
  const providerConfig = getOrganizationProviderPrivacy(settings);
  let effectiveProviderConfig = providerConfig;
  let groupModelAllowed = true;
  let groupModelAllowedForInferenceProviderUserByok = true;
  let groupProvidersAllowed = true;
  let allowedProviders: ReadonlySet<string> | undefined;
  if (groupPolicy) {
    const groupDecision = await getEffectiveModelDecision(groupPolicy, input.model);
    groupModelAllowed = groupDecision.allowed;
    // An `organization_provider` denial means no allowed provider serves the model.
    allowedProviders = groupDecision.allowed ? groupDecision.eligibleProviderRoutes : new Set();
    groupModelAllowedForInferenceProviderUserByok = allowsInferenceProviderUserByok(groupDecision);
    if (groupDecision.eligibleProviderRoutes) {
      const only = withoutVirtualProvider([...groupDecision.eligibleProviderRoutes]);
      groupProvidersAllowed = only.length > 0;
      effectiveProviderConfig = { ...providerConfig, only };
    }
  }
  return {
    allowedProviders,
    effectiveProviderConfig: effectiveProviderConfig
      ? { ...effectiveProviderConfig, ...input.effectivePrivacy }
      : undefined,
    groupModelAllowed,
    groupModelAllowedForInferenceProviderUserByok,
    groupProvidersAllowed,
  };
}

async function resolveIsNonTrialEnterprise(input: ProviderPolicyInput): Promise<boolean> {
  if (!input.organizationId) return false;
  const { plan } = await input.balanceAndSettingsPromise;
  if (plan !== 'enterprise') return false;
  return await isNonTrialEnterpriseOrganization(input.organizationId, readDb);
}

/**
 * Selects the provider for the resolved model and applies balance, organization, data-collection
 * and custom LLM provider policy, rewriting the request's provider object to match.
 */
export async function resolveProviderAndPolicy(
  input: ProviderPolicyInput
): Promise<ProviderPolicyResult> {
  const { request, model, user, modelResolution } = input;
  const reject = (response: NextResponseType<unknown>) => ({ ok: false, response }) as const;
  const orgAutoRouteTarget =
    modelResolution.kind === 'routed' && modelResolution.autoModel === ORG_AUTO_MODEL.id
      ? modelResolution.routingTarget
      : null;
  const poolRouted = modelResolution.kind === 'routed' && modelResolution.poolRouted;

  let accessCheck: ReturnType<typeof resolveAccessCheck> | undefined;
  const getAccessCheck = () => (accessCheck ??= resolveAccessCheck(input));
  const isAnonymous = isAnonymousContext(user);
  const isDirectByokProviderAllowed = async (policyProviderId: string) => {
    const groupPolicy = await input.organizationGroupPolicyPromise;
    return (
      !groupPolicy || (await isModelAllowedForProviderKey(groupPolicy, model, policyProviderId))
    );
  };

  const isNonTrialEnterprise = await resolveIsNonTrialEnterprise(input);
  const organizationGatewaySettings = input.organizationId
    ? getOrganizationGatewaySettings(
        await getRuntimeOrganizationFeatures(),
        input.organizationId,
        (await input.balanceAndSettingsPromise).settings
      )
    : NO_ORGANIZATION_GATEWAY_SETTINGS;
  const providerResult = await getProvider({
    requestedModel: model,
    request,
    user,
    organizationId: input.organizationId,
    botId: input.botId,
    boundedSpending: input.boundedSpending,
    organizationDisabledVercelAiGateway: organizationGatewaySettings.disabledGateways.has('vercel'),
    countryCode: input.countryCode,
    getRoutingProviderConfig: async () =>
      (isAnonymous ? undefined : (await getAccessCheck()).effectiveProviderConfig) ??
      request.body.provider,
    getAllowedProviders: async () =>
      isAnonymous ? undefined : (await getAccessCheck()).allowedProviders,
    isDirectByokProviderAllowed,
    kiloIgnoredProviders: getIgnoredProviders(model, isNonTrialEnterprise),
    onDecision: decision => input.providerMetadataCapture?.captureRoutingDecision(decision),
  });
  if (providerResult.kind === 'chatgpt-reconnect') {
    // The person's enabled ChatGPT connection is terminally dead. Fail readably
    // instead of silently serving the request through another billing path.
    return reject(chatGptReconnectResponse(providerResult.message));
  }
  if (providerResult.kind === 'claude-billing-unavailable') {
    // The owner's Claude billing connection cannot bill. Never serve it on
    // another payer's allowance without telling them.
    return reject(
      claudeBillingUnavailableResponse(providerResult.message, providerResult.retryable)
    );
  }
  if (providerResult.kind === 'custom-llm-unavailable') {
    // Same response as an unknown model id, so callers cannot probe for custom LLMs.
    return reject(modelDoesNotExistOnOpenRouterResponse(model));
  }
  if (providerResult.kind === 'direct-byok-catalog-only') {
    // Falling through to the managed gateway would fail later with a misleading unknown-model error.
    const message = directByokCatalogOnlyMessage({
      model,
      providerId: providerResult.providerId,
      catalogModelId: providerResult.catalogModelId,
    });
    return reject(
      orgAutoRouteTarget
        ? organizationAutoConfigurationResponse(
            `Organization Auto route target '${orgAutoRouteTarget}' is unavailable: ${message}`
          )
        : directByokCatalogOnlyResponse(message)
    );
  }
  // A local, so the type guard narrows it rather than `providerResult.provider.type`.
  const providerType = providerResult.provider.type;
  if (providerType === 'claude-billing' && !(await isDirectByokProviderAllowed('anthropic'))) {
    return reject(modelNotAllowedResponse());
  }
  if (isManagedGatewayDisabled(organizationGatewaySettings, providerType)) {
    return reject(managedGatewayDisabledResponse(providerType));
  }
  const providerBaseUrl =
    providerResult.provider.apiUrlOverrides[request.kind] ?? providerResult.provider.apiUrl;
  const gatewayByDomain = getManagedGatewayFromUrl(providerBaseUrl);
  if (gatewayByDomain && isManagedGatewayDisabled(organizationGatewaySettings, gatewayByDomain)) {
    return reject(managedGatewayDisabledResponse(gatewayByDomain));
  }
  if (orgAutoRouteTarget) {
    try {
      const directByokTarget = await getDirectByokModel(orgAutoRouteTarget);
      if (directByokTarget.provider && providerResult.provider.type !== 'direct-byok') {
        return reject(
          organizationAutoConfigurationResponse(
            `Organization Auto route target '${orgAutoRouteTarget}' is unavailable because this organization does not have an enabled BYOK credential for ${directByokTarget.provider.id}.`
          )
        );
      }
    } catch {
      return reject(
        organizationAutoConfigurationResponse(
          'Organization Auto could not validate this route target against the current model catalog.'
        )
      );
    }
  }

  if (!providerResult.provider.supportedChatApis.includes(request.kind)) {
    return reject(
      apiKindNotSupportedResponse(
        request.kind,
        providerResult.provider.supportedChatApis,
        providerResult.provider.type === 'direct-byok'
          ? providerResult.userByok?.[0]?.providerId
          : undefined
      )
    );
  }

  if (modelResolution.kind === 'direct' && (await isUnavailableModel(model))) {
    console.warn(`User requested unavailable model ${model}; rejecting.`);
    return reject(unavailableModelResponse());
  }

  // Skip balance/org checks for anonymous users - they can only use free models
  if (!isAnonymousContext(user)) {
    const creditsBlocked = paidUsageRejection({
      user,
      organizationId: input.organizationId,
      account: await input.balanceAndSettingsPromise,
      exempt:
        providerResult.isFree || !!providerResult.userByok || !!providerResult.skipBalanceCheck,
    });
    if (creditsBlocked) return reject(await creditsBlocked());
  }

  if (!isAnonymous && !providerResult.bypassAccessCheck) {
    const {
      allowedProviders,
      effectiveProviderConfig,
      groupModelAllowed,
      groupModelAllowedForInferenceProviderUserByok,
      groupProvidersAllowed,
    } = await getAccessCheck();

    if (providerResult.provider.type === 'direct-byok') {
      // A catalog-mode direct BYOK key is the request's only route, so the policy is checked
      // against the key's provider alone. Routing already skips keys it rejects.
      const directByokProvider = findDirectByokProvider(
        providerResult.userByok?.[0]?.providerId ?? ''
      );
      if (
        !directByokProvider ||
        !(await isDirectByokProviderAllowed(getDirectByokPolicyProviderId(directByokProvider)))
      ) {
        return reject(poolRouted ? efficientPoolBlockedResponse() : modelNotAllowedResponse());
      }
    } else {
      const modelAllowed = isInferenceProviderUserByok(providerResult.userByok)
        ? groupModelAllowedForInferenceProviderUserByok
        : groupModelAllowed;
      if (!modelAllowed) {
        return reject(poolRouted ? efficientPoolBlockedResponse() : modelNotAllowedResponse());
      }
      if (!groupProvidersAllowed) return reject(modelNotAllowedResponse());
      if (
        providerResult.provider.type === 'vercel' &&
        providerResult.userByok?.some(
          byok => !isVercelUserByokProviderAllowed(byok.providerId, allowedProviders)
        )
      ) {
        return reject(modelNotAllowedResponse());
      }
    }

    if (effectiveProviderConfig) {
      request.body.provider = effectiveProviderConfig;
    }
  }

  if (
    (await hasBestEffortGuessDataCollectionRequirement(model)) &&
    isDataCollectionExplicitlyDisallowed(request.body.provider)
  ) {
    return reject(dataCollectionRequiredResponse());
  }

  if (input.customLlm?.definition.public) {
    // Organization policy replaces the request's provider object, so intersect
    // the caller's own only/ignore lists, the organization's, and the declared
    // providers, and forward only that intersection.
    const declaredProviders = input.customLlm.definition.public.inference_providers;
    const eligibleProviders = allowedInferenceProviders(
      declaredProviders,
      input.requestProvider,
      request.body.provider
    );
    if (eligibleProviders.length === 0) {
      return reject(inferenceProvidersNotAllowedResponse(declaredProviders));
    }
    if (eligibleProviders.length < declaredProviders.length) {
      request.body.provider = { ...request.body.provider, only: eligibleProviders };
    }
  }

  return {
    ok: true,
    providerResult,
    isNonTrialEnterprise,
    dataRegion: organizationGatewaySettings.dataRegion,
  };
}
