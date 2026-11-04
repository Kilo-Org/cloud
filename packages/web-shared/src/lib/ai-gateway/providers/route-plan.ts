import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { canRouteToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  GatewayUserByokProviderIdSchema,
  getVercelProviderIdForUserByok,
  isGatewayUserByokProviderId,
  isVercelUserByokProviderAllowed,
  type GatewayUserByokProviderId,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import {
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  isGatewayUserByokEligibleModel,
  type ByokKeyState,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { createByokRouteRank } from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import {
  findDirectByokCatalogModels,
  getDirectByokModel,
  getDirectByokModelChatApis,
  getDirectByokPolicyProviderId,
  type DirectByokCatalogModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  DirectByokModel,
  DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { getOpenAiChatGptCandidateModel } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  findCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export type RequestedModel =
  /** A custom LLM owns its id, so no key or Kilo route applies. */
  | { kind: 'custom-llm'; customLlm: CustomLlm }
  /** A provider model id such as `synthetic/...`, served only by that provider's key. */
  | { kind: 'direct-byok-model'; provider: DirectByokProvider; model: DirectByokModel }
  | { kind: 'catalog' };

export async function classifyRequestedModel(requestedModel: string): Promise<RequestedModel> {
  const customLlm = await findCustomLlm(requestedModel);
  if (customLlm) return { kind: 'custom-llm', customLlm };
  const { provider, model } = await getDirectByokModel(requestedModel);
  if (provider && model) return { kind: 'direct-byok-model', provider, model };
  return { kind: 'catalog' };
}

type KeyPlanStepBase = {
  key: ByokKeyState;
  /** The key's position in the owner's whole key list (`createByokRouteRank`). */
  routeOrder: number;
};

export type DirectByokPlanStep = KeyPlanStepBase &
  DirectByokCatalogModel & {
    route: 'direct-byok';
    decision: 'serves' | 'unsupported-api-kind' | 'disabled' | 'not-catalog-mode';
  };

export type VercelByokPlanStep = KeyPlanStepBase & {
  route: 'vercel-byok';
  decision: 'serves' | 'disabled';
  /**
   * The request's own `provider.ignore` names the key's provider. The key then yields to any later
   * route that serves, and serves from the `ignored-key-fallback` step when nothing else does, so the
   * preference never makes Kilo pay instead.
   */
  ignoredByRequest: boolean;
};

export type GatewayByokPlanStep = KeyPlanStepBase & {
  route: 'gateway-byok';
  providerId: GatewayUserByokProviderId;
  decision: 'disabled' | GatewayKeyDecision;
};

export type KeyPlanStep = DirectByokPlanStep | VercelByokPlanStep | GatewayByokPlanStep;

/**
 * The routes `getProvider` tries for a catalog id, in order; the first that serves takes the
 * request. `previewByokRouting` shows the same plan on the BYOK settings page.
 */
export type RoutePlanStep =
  | KeyPlanStep
  /** The person's "Sign in with ChatGPT" connection, usable only if it is connected. */
  | { route: 'chatgpt' }
  | { route: 'ignored-key-fallback'; step: VercelByokPlanStep }
  /** No key serves, but a catalog-mode key serves the model over another API kind. */
  | { route: 'unsupported-api-kind'; step: DirectByokPlanStep }
  | { route: 'kilo' };

/** The policy and request inputs mirror `GetProviderInput`. */
export type RoutePlanInputs = {
  requestedModel: string;
  apiKind: GatewayChatApiKind;
  /**
   * The owner's keys, in `getByokKeyStates` order, or null when the caller cannot own keys. Called
   * only when a key could serve the model.
   */
  loadKeys: (() => Promise<readonly ByokKeyState[]>) | null;
  isDirectByokProviderAllowed: (policyProviderId: string) => Promise<boolean>;
  getAllowedProviders: () => Promise<ReadonlySet<string> | undefined>;
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>;
  /** `getRequestIgnoredVercelProviderIds` of the request. */
  requestIgnoredProviders: ReadonlySet<string>;
  /** Receives the providers whose keys the organization policy excludes before they are ranked. */
  onExcludedByPolicy?: (providerIds: string[]) => void;
};

/**
 * The providers whose stored key could serve a catalog model through a gateway, unlike direct
 * BYOK, where the model ID itself names the provider.
 */
async function getGatewayRoutedByokCandidateProviders(
  requestedModel: string,
  { includeGatewayKeys }: { includeGatewayKeys: boolean }
): Promise<UserByokProviderId[]> {
  // Kilo pays for the auto small free model, so no user key may serve it.
  if (isAutoSmallFreeModel(requestedModel)) return [];
  return [
    ...(await getModelInferenceUserByokProviders(requestedModel)),
    ...(includeGatewayKeys && isGatewayUserByokEligibleModel(requestedModel)
      ? GatewayUserByokProviderIdSchema.options
      : []),
  ];
}

/**
 * The providers whose keys may serve the model through a gateway. Keys for providers outside the
 * organization allow-list are never decrypted, so a later route that honors the allow-list takes
 * the request, and an undecryptable allowed key still fails closed.
 */
export async function getAllowedGatewayRoutedByokProviders(
  requestedModel: string,
  options: {
    includeGatewayKeys: boolean;
    getAllowedProviders: () => Promise<ReadonlySet<string> | undefined>;
    onExcludedByPolicy?: (providerIds: UserByokProviderId[]) => void;
  }
): Promise<UserByokProviderId[]> {
  const allProviders = await getGatewayRoutedByokCandidateProviders(requestedModel, options);
  if (allProviders.length === 0) return [];
  const allowedProviders = await options.getAllowedProviders();
  const allowed = allProviders.filter(providerId =>
    isVercelUserByokProviderAllowed(providerId, allowedProviders)
  );
  const excluded = allProviders.filter(providerId => !allowed.includes(providerId));
  if (excluded.length > 0) options.onExcludedByPolicy?.(excluded);
  return allowed;
}

/** The catalog-mode providers that serve the model and the organization policy admits. */
async function getAllowedDirectByokCatalogModels(
  inputs: RoutePlanInputs
): Promise<DirectByokCatalogModel[]> {
  const allowed: DirectByokCatalogModel[] = [];
  const excludedProviderIds: string[] = [];
  for (const catalogModel of await findDirectByokCatalogModels(inputs.requestedModel)) {
    if (
      await inputs.isDirectByokProviderAllowed(getDirectByokPolicyProviderId(catalogModel.provider))
    ) {
      allowed.push(catalogModel);
    } else {
      excludedProviderIds.push(catalogModel.provider.id);
    }
  }
  if (excludedProviderIds.length > 0) inputs.onExcludedByPolicy?.(excludedProviderIds);
  return allowed;
}

function decideDirectByokKey(
  { provider, model }: DirectByokCatalogModel,
  key: ByokKeyState,
  apiKind: GatewayChatApiKind
): DirectByokPlanStep['decision'] {
  if (!key.isEnabled) return 'disabled';
  if (!key.serveCatalogModels) return 'not-catalog-mode';
  return getDirectByokModelChatApis(provider, model).includes(apiKind)
    ? 'serves'
    : 'unsupported-api-kind';
}

type GatewayKeyDecision = 'serves' | 'model-unavailable' | 'provider-settings';

/** Whether a whole-gateway key can serve the model, under the provider routing settings. */
function createGatewayKeyDecider(
  requestedModel: string,
  getRoutingProviderConfig: () => Promise<OpenRouterProviderConfig | undefined>
) {
  let gatewayProviders: Promise<readonly string[]> | undefined;
  return async (providerId: GatewayUserByokProviderId): Promise<GatewayKeyDecision> => {
    gatewayProviders ??= getModelGatewayUserByokProviders(requestedModel);
    if (!(await gatewayProviders).includes(providerId)) return 'model-unavailable';
    if (
      providerId === 'vercel-ai-gateway' &&
      !(await canRouteToVercel(requestedModel, getRoutingProviderConfig))
    ) {
      return 'provider-settings';
    }
    return 'serves';
  };
}

/**
 * Every key that might serve the request, in the owner's route order (`createByokRouteRank` over
 * all of the owner's keys), each with whether it serves. A disabled key stays in the list so the
 * settings page can explain it.
 */
async function planKeySteps(inputs: RoutePlanInputs): Promise<KeyPlanStep[]> {
  if (!inputs.loadKeys) return [];
  const { requestedModel, apiKind } = inputs;
  const catalogModels = await getAllowedDirectByokCatalogModels(inputs);
  const gatewayRoutedProviders = await getAllowedGatewayRoutedByokProviders(requestedModel, {
    includeGatewayKeys: true,
    getAllowedProviders: inputs.getAllowedProviders,
    onExcludedByPolicy: inputs.onExcludedByPolicy,
  });
  if (catalogModels.length === 0 && gatewayRoutedProviders.length === 0) return [];

  const keys = await inputs.loadKeys();
  const rank = createByokRouteRank(keys);
  const steps = catalogModels.flatMap<KeyPlanStep>(catalogModel => {
    const key = keys.find(candidate => candidate.providerId === catalogModel.provider.id);
    if (!key) return [];
    return [
      {
        route: 'direct-byok',
        ...catalogModel,
        key,
        routeOrder: rank(key.providerId),
        decision: decideDirectByokKey(catalogModel, key, apiKind),
      },
    ];
  });
  const decideGatewayKey = createGatewayKeyDecider(requestedModel, inputs.getRoutingProviderConfig);
  for (const key of keys) {
    if (!gatewayRoutedProviders.includes(key.providerId)) continue;
    const routeOrder = rank(key.providerId);
    if (isGatewayUserByokProviderId(key.providerId)) {
      steps.push({
        route: 'gateway-byok',
        key,
        routeOrder,
        providerId: key.providerId,
        decision: key.isEnabled ? await decideGatewayKey(key.providerId) : 'disabled',
      });
    } else {
      steps.push({
        route: 'vercel-byok',
        key,
        routeOrder,
        decision: key.isEnabled ? 'serves' : 'disabled',
        ignoredByRequest:
          key.isEnabled &&
          inputs.requestIgnoredProviders.has(getVercelProviderIdForUserByok(key.providerId)),
      });
    }
  }
  return steps.toSorted((a, b) => a.routeOrder - b.routeOrder);
}

export function isKeyPlanStep(step: RoutePlanStep): step is KeyPlanStep {
  return (
    step.route === 'direct-byok' || step.route === 'vercel-byok' || step.route === 'gateway-byok'
  );
}

/**
 * Plans the routes for a catalog id from key metadata and cached catalog lookups only: it never
 * decrypts a key or calls KMS.
 *
 * - The keys come in the owner's route order, each with its decision.
 * - A "Sign in with ChatGPT" connection is not in the key list. For an eligible OpenAI responses
 *   request it goes right before the first provider or gateway key that serves, so only the keys
 *   ranked above that key come first; when no such key serves, it goes after every key. The
 *   request's `provider.ignore` does not move it.
 * - A key the request ignores serves after every other key.
 * - BYOK requests are never billed to Kilo, so when no key serves a catalog id that a catalog-mode
 *   key serves over another API kind, the request fails with the unsupported-API error.
 * - Kilo's paid route comes last.
 */
export async function planRoutes(inputs: RoutePlanInputs): Promise<RoutePlanStep[]> {
  const keySteps = await planKeySteps(inputs);
  const steps: RoutePlanStep[] = [...keySteps];

  if (await getOpenAiChatGptCandidateModel(inputs.apiKind, inputs.requestedModel)) {
    const firstServingGatewayRouted = keySteps.findIndex(
      step => step.route !== 'direct-byok' && step.decision === 'serves'
    );
    steps.splice(firstServingGatewayRouted === -1 ? steps.length : firstServingGatewayRouted, 0, {
      route: 'chatgpt',
    });
  }

  const ignored = keySteps.find(
    (step): step is VercelByokPlanStep => step.route === 'vercel-byok' && step.ignoredByRequest
  );
  if (ignored) steps.push({ route: 'ignored-key-fallback', step: ignored });

  const unsupported = keySteps.some(step => step.decision === 'serves')
    ? undefined
    : keySteps.find(
        (step): step is DirectByokPlanStep =>
          step.route === 'direct-byok' && step.decision === 'unsupported-api-kind'
      );
  if (unsupported) steps.push({ route: 'unsupported-api-kind', step: unsupported });

  steps.push({ route: 'kilo' });
  return steps;
}
