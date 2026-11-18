import type { NextResponse as NextResponseType } from 'next/server';
import type { User } from '@kilocode/db';
import {
  getProvider,
  type ProviderRoute,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import type { ProviderType } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { FailoverRoute } from '@kilocode/web-shared/lib/ai-gateway/providers/byok-failover';
import type { AiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';
import type { OrganizationGatewaySettings } from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import {
  dataCollectionPolicyRejection,
  gatewaySettingsRejection,
  paidUsageRejection,
  resolveOrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { getIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { isNonTrialEnterpriseOrganization } from '@kilocode/web-shared/lib/organizations/non-trial-enterprise';
import {
  getDirectByokModel,
  type DirectByokPolicyTarget,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { isInferenceProviderUserByok } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { isVercelUserByokProviderAllowed } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  allowedInferenceProviders,
  apiKindNotSupportedResponse,
  chatGptReconnectResponse,
  claudeBillingReconnectResponse,
  claudeBillingUnavailableResponse,
  directByokCatalogOnlyMessage,
  directByokCatalogOnlyResponse,
  efficientPoolBlockedResponse,
  getOrganizationProviderPrivacy,
  inferenceProvidersNotAllowedResponse,
  unknownModelResponse,
  modelNotAllowedResponse,
  organizationAutoConfigurationResponse,
  unavailableModelResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type { BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
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
import {
  composeProviderPreferences,
  type getEffectiveProviderPrivacy,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import type { ValidatedGatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-request';
import type { AdmittedModelResolution } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-model-resolution';

/**
 * The OpenRouter provider slug each delegated route stands for in the organization provider
 * policy. A delegated route serves the request from its own upstream, so the policy is compared
 * with that provider directly.
 */
const DELEGATED_ROUTE_POLICY_PROVIDER_ID: Partial<Record<ProviderType, string>> = {
  'claude-billing': 'anthropic',
  'openai-chatgpt': 'openai',
};

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
      /** The first of `getProvider`'s routes, which the policy admits. */
      route: ProviderRoute;
      /** `getProvider`'s later routes, each resolving to null when the policy refuses it. */
      failoverRoutes: readonly FailoverRoute[];
      isNonTrialEnterprise: boolean;
      /**
       * The organization's inference region. Only a route Kilo pays for through the Vercel AI
       * Gateway is pinned to it (see `getRouteInferenceRegion`).
       */
      dataRegion: OrganizationGatewaySettings['dataRegion'];
    }
  | { ok: false; response: NextResponseType<unknown> };

async function resolveAccessCheck(input: ProviderPolicyInput) {
  const { settings } = await input.balanceAndSettingsPromise;
  const groupPolicy = await input.organizationGroupPolicyPromise;
  const organizationPrivacy = getOrganizationProviderPrivacy(settings);
  let organizationOnly: string[] | undefined;
  let effectiveProviderConfig: OpenRouterProviderConfig | undefined;
  let groupModelAllowed = true;
  let groupModelAllowedForInferenceProviderUserByok = true;
  let groupProvidersAllowed = true;
  let providerPreferencesExhausted = false;
  let allowedProviders: ReadonlySet<string> | undefined;
  if (groupPolicy) {
    const groupDecision = await getEffectiveModelDecision(groupPolicy, input.model);
    groupModelAllowed = groupDecision.allowed;
    // An `organization_provider` denial means no allowed provider serves the model.
    allowedProviders = groupDecision.allowed ? groupDecision.eligibleProviderRoutes : new Set();
    groupModelAllowedForInferenceProviderUserByok = allowsInferenceProviderUserByok(groupDecision);
    if (groupDecision.eligibleProviderRoutes) {
      organizationOnly = withoutVirtualProvider([...groupDecision.eligibleProviderRoutes]);
    }
  }
  if (organizationPrivacy || organizationOnly) {
    const composed = composeProviderPreferences({
      requestProvider: input.requestProvider,
      organizationOnly,
      effectivePrivacy: input.effectivePrivacy,
    });
    if (composed.kind === 'none') {
      providerPreferencesExhausted = true;
      // A public custom LLM answers its own provider_not_allowed response, which names the
      // providers the model needs, so it keeps that answer instead of the generic refusal.
      if (!input.customLlm?.definition.public) groupProvidersAllowed = false;
    } else {
      effectiveProviderConfig = composed.provider;
    }
  }
  return {
    allowedProviders,
    effectiveProviderConfig,
    groupModelAllowed,
    groupModelAllowedForInferenceProviderUserByok,
    groupProvidersAllowed,
    providerPreferencesExhausted,
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
  /** Whether the organization policy admits the model served by this one provider. */
  const isModelAllowedForPolicyProvider = async (policyProviderId: string) => {
    const groupPolicy = await input.organizationGroupPolicyPromise;
    return (
      !groupPolicy || (await isModelAllowedForProviderKey(groupPolicy, model, policyProviderId))
    );
  };
  /**
   * Whether the organization policy admits the model served by a catalog-mode direct BYOK key. The
   * organization configured its own endpoints, so its provider allow-lists do not restrict them.
   */
  const isDirectByokServingAllowed = async (target: DirectByokPolicyTarget) =>
    target.kind === 'provider'
      ? isModelAllowedForPolicyProvider(target.providerSlug)
      : !isAnonymous &&
        !!input.organizationId &&
        (await getAccessCheck()).groupModelAllowedForInferenceProviderUserByok;

  const isNonTrialEnterprise = await resolveIsNonTrialEnterprise(input);
  const organizationAccount = input.organizationId
    ? await input.balanceAndSettingsPromise
    : undefined;
  const organizationGatewaySettings = await resolveOrganizationGatewaySettings({
    organizationId: input.organizationId,
    plan: organizationAccount?.plan,
    settings: organizationAccount?.settings,
  });
  const getProviderResult = await getProvider({
    requestedModel: model,
    request,
    user,
    organizationId: input.organizationId,
    botId: input.botId,
    boundedSpending: input.boundedSpending,
    countryCode: input.countryCode,
    getRoutingProviderConfig: async () =>
      (isAnonymous ? undefined : (await getAccessCheck()).effectiveProviderConfig) ??
      request.body.provider,
    getAllowedProviders: async () =>
      isAnonymous ? undefined : (await getAccessCheck()).allowedProviders,
    isDirectByokProviderAllowed: isDirectByokServingAllowed,
    kiloIgnoredProviders: getIgnoredProviders(model, isNonTrialEnterprise),
    openRouterDisabled: organizationGatewaySettings.openRouterDisabled,
    onDecision: decision => input.providerMetadataCapture?.captureRoutingDecision(decision),
  });
  if (getProviderResult.kind === 'chatgpt-reconnect') {
    // The person's enabled ChatGPT connection is terminally dead. Fail readably
    // instead of silently serving the request through another billing path.
    return reject(chatGptReconnectResponse(getProviderResult.message));
  }
  if (getProviderResult.kind === 'claude-billing-reconnect') {
    // The organization's Claude link was connected by a person who is gone.
    // Only an owner reconnecting it changes the outcome.
    return reject(claudeBillingReconnectResponse(getProviderResult.message, input.organizationId));
  }
  if (getProviderResult.kind === 'claude-billing-unavailable') {
    // The owner's Claude billing connection cannot bill. Never serve it on
    // another payer's allowance without telling them.
    return reject(
      claudeBillingUnavailableResponse(getProviderResult.message, getProviderResult.retryable)
    );
  }
  if (
    getProviderResult.kind === 'custom-llm-unavailable' ||
    getProviderResult.kind === 'byok-endpoint-unavailable'
  ) {
    // Same response as an unknown model id, so callers cannot probe for custom LLMs or endpoints.
    return reject(unknownModelResponse(model));
  }
  if (getProviderResult.kind === 'direct-byok-catalog-only') {
    // Falling through to the managed gateway would fail later with a misleading unknown-model error.
    const message = directByokCatalogOnlyMessage({
      model,
      keyLabel: getProviderResult.keyLabel,
      catalogModelId: getProviderResult.catalogModelId,
    });
    return reject(
      orgAutoRouteTarget
        ? organizationAutoConfigurationResponse(
            `Organization Auto route target '${orgAutoRouteTarget}' is unavailable: ${message}`
          )
        : directByokCatalogOnlyResponse(message)
    );
  }
  /** Why the policy refuses the route, or null when it may serve the request. */
  const routeRejection = async (
    route: ProviderRoute
  ): Promise<NextResponseType<unknown> | null> => {
    const providerType = route.provider.type;
    const delegatedPolicyProviderId = DELEGATED_ROUTE_POLICY_PROVIDER_ID[providerType];
    if (
      delegatedPolicyProviderId &&
      !(await isModelAllowedForPolicyProvider(delegatedPolicyProviderId))
    ) {
      return modelNotAllowedResponse();
    }
    const gatewayRejection = gatewaySettingsRejection(organizationGatewaySettings, {
      provider: {
        type: providerType,
        apiUrl: route.provider.apiUrlOverrides[request.kind] ?? route.provider.apiUrl,
      },
      userByok: route.userByok,
    });
    if (gatewayRejection) return gatewayRejection;
    if (orgAutoRouteTarget) {
      try {
        const directByokTarget = await getDirectByokModel(orgAutoRouteTarget);
        if (directByokTarget.provider && route.provider.type !== 'direct-byok') {
          return organizationAutoConfigurationResponse(
            `Organization Auto route target '${orgAutoRouteTarget}' is unavailable because this organization does not have an enabled BYOK credential for ${directByokTarget.provider.id}.`
          );
        }
      } catch {
        return organizationAutoConfigurationResponse(
          'Organization Auto could not validate this route target against the current model catalog.'
        );
      }
    }

    if (!route.provider.supportedChatApis.includes(request.kind)) {
      return apiKindNotSupportedResponse(
        request.kind,
        route.provider.supportedChatApis,
        route.provider.directByokKeyLabel
      );
    }

    if (modelResolution.kind === 'direct' && (await isUnavailableModel(model))) {
      console.warn(`User requested unavailable model ${model}; rejecting.`);
      return unavailableModelResponse();
    }

    // Skip balance/org checks for anonymous users - they can only use free models
    if (!isAnonymousContext(user)) {
      const creditsBlocked = paidUsageRejection({
        user,
        organizationId: input.organizationId,
        account: await input.balanceAndSettingsPromise,
        exempt: route.isFree || !!route.userByok || !!route.skipBalanceCheck,
      });
      if (creditsBlocked) return await creditsBlocked();
    }

    // Organization model and provider policies cover catalog ids. The exemption here is
    // intentional: a bespoke direct-BYOK id, a non-public custom LLM and the local fake LLM
    // already require explicit admin opt-in. `llm-proxy.ts` merges the organization provider
    // privacy into `request.body.provider` before routing, so the data-collection policy below
    // still applies to these routes.
    if (isAnonymous || route.bypassAccessCheck) return null;
    const {
      allowedProviders,
      groupModelAllowed,
      groupModelAllowedForInferenceProviderUserByok,
      groupProvidersAllowed,
    } = await getAccessCheck();

    if (route.provider.type === 'direct-byok') {
      // A catalog-mode direct BYOK key is the request's only route, so the policy is checked
      // against its target alone: the key's provider, or for the organization's own endpoint, only
      // the model policy. Routing already skips keys it rejects.
      if (
        !route.directByokPolicyTarget ||
        !(await isDirectByokServingAllowed(route.directByokPolicyTarget))
      ) {
        return poolRouted ? efficientPoolBlockedResponse() : modelNotAllowedResponse();
      }
      return null;
    }
    const modelAllowed = isInferenceProviderUserByok(route.userByok)
      ? groupModelAllowedForInferenceProviderUserByok
      : groupModelAllowed;
    if (!modelAllowed) {
      return poolRouted ? efficientPoolBlockedResponse() : modelNotAllowedResponse();
    }
    if (!groupProvidersAllowed) return modelNotAllowedResponse();
    if (
      route.provider.type === 'vercel' &&
      route.userByok?.some(
        byok => !isVercelUserByokProviderAllowed(byok.providerId, allowedProviders)
      )
    ) {
      return modelNotAllowedResponse();
    }
    return null;
  };

  const [resolveFirstRoute, ...resolveFailoverRoutes] = getProviderResult.routes;
  const route = await resolveFirstRoute();
  const rejection = await routeRejection(route);
  if (rejection) return reject(rejection);

  // Exempt routes already carry the organization provider privacy that `llm-proxy.ts` applied
  // before routing, so the data-collection policy below reads the same preference on both paths.
  if (!isAnonymous && !route.bypassAccessCheck) {
    const { effectiveProviderConfig } = await getAccessCheck();
    if (effectiveProviderConfig) {
      request.body.provider = effectiveProviderConfig;
    }
  }

  const dataCollectionRejected = await dataCollectionPolicyRejection(model, request.body.provider);
  if (dataCollectionRejected) return reject(dataCollectionRejected);

  if (input.customLlm?.definition.public) {
    // Organization policy composes the forwarded provider object, so intersect the caller's own
    // only/ignore lists, the organization's, and the declared providers, and forward only that
    // intersection.
    const declaredProviders = input.customLlm.definition.public.inference_providers;
    const providerPreferencesExhausted =
      !isAnonymous && (await getAccessCheck()).providerPreferencesExhausted;
    const eligibleProviders = providerPreferencesExhausted
      ? []
      : allowedInferenceProviders(declaredProviders, input.requestProvider, request.body.provider);
    if (eligibleProviders.length === 0) {
      return reject(inferenceProvidersNotAllowedResponse(declaredProviders));
    }
    if (eligibleProviders.length < declaredProviders.length) {
      request.body.provider = { ...request.body.provider, only: eligibleProviders };
    }
  }

  const failoverRoutes = resolveFailoverRoutes.map(
    resolveRoute => async (): Promise<ProviderRoute | null> => {
      let failoverRoute: ProviderRoute;
      try {
        failoverRoute = await resolveRoute();
      } catch (error) {
        console.error('[byok-failover] Skipping a BYOK key that could not be resolved', {
          errorType: error instanceof Error ? error.name : 'unknown',
        });
        return null;
      }
      if (await routeRejection(failoverRoute)) {
        console.warn('[byok-failover] Skipping a BYOK key the policy refuses', {
          providerIds: failoverRoute.userByok?.map(byok => byok.providerId) ?? [],
        });
        return null;
      }
      return failoverRoute;
    }
  );

  return {
    ok: true,
    route,
    failoverRoutes,
    isNonTrialEnterprise,
    dataRegion: organizationGatewaySettings.dataRegion,
  };
}
