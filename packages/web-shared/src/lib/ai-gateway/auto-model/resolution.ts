import type {
  GatewayRequest,
  GeminiGenerationConfig,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type OpenAI from 'openai';
import type { User } from '@kilocode/db';
import type {
  OrganizationPlan,
  OrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  isCustomRouterModelId,
  isVirtualAutoModelId,
  parseCustomRouterModelId,
  type AutoRoutingDecision,
  type CustomRouterErrorCode,
  type CustomRouterReference,
} from '@kilocode/auto-routing-contracts';
import {
  CUSTOM_ROUTER_NOT_FOUND,
  type CustomRouterResolution,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/custom-router';
import {
  AUTO_SMALL_TARGET_MODELS,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
  type ResolvedAutoModel,
  ORG_AUTO_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  type AutoFreeModel,
  PRIMARY_DEFAULT_MODEL,
  selectAutoFreeCandidate,
} from '@kilocode/web-shared/lib/ai-gateway/models';
import {
  AUTO_FREE_FALLBACK_MODEL,
  getConfiguredAutoFreeModels,
  isAutoFreeEligibleModelId,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import {
  findKiloExclusiveModel,
  isKiloExclusiveFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { getOpenRouterModelsFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getOrganizationAutoRoute,
  isOrganizationAutoTargetModel,
  validateOrganizationAutoTarget,
} from '@kilocode/web-shared/lib/organizations/organization-auto-model';
import { getModelVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import type { OpenCodeVariant } from '@kilocode/db/schema-types';

type ResolveAutoModelParams = {
  model: string;
  modeHeader: string | null;
  sessionId: string | null;
  apiKind: GatewayRequest['kind'] | null;
  clientIp: string | null;
  isAutoFreeCandidateAllowed: ((modelId: string) => Promise<boolean>) | null;
  // Decisions are lazy so only the selected router captures the request body.
  efficientDecision?: () => Promise<AutoRoutingDecision | null>;
  frontierDecision?: () => Promise<AutoRoutingDecision | null>;
  customRouterDecision?: (reference: CustomRouterReference) => Promise<CustomRouterResolution>;
  legacyPoolRouter?: () => Promise<CustomRouterReference | null>;
  organizationContext?: Promise<{
    organizationId?: string;
    settings?: OrganizationSettings;
    plan?: OrganizationPlan;
  }>;
};

/**
 * Returns the eligible models for kilo-auto/free routing from the admin
 * configuration, falling back to `openrouter/free` when nothing is
 * configured, the configuration is invalid, or no configured model is eligible.
 *
 * Non-kilo-exclusive free models are only eligible when they appear in the
 * OpenRouter models cache. Kilo-exclusive free models are eligible when their
 * gateway supports the current `apiKind`; when `apiKind` is null no API-kind
 * filtering is applied.
 */
async function getEligibleAutoFreeModels(
  apiKind: GatewayRequest['kind'] | null
): Promise<ReadonlyArray<AutoFreeModel>> {
  const configuredModels = await getConfiguredAutoFreeModels();
  if (!configuredModels) return [AUTO_FREE_FALLBACK_MODEL];

  const openRouterModels = await getOpenRouterModelsFromDatabase();
  const eligibleModels = configuredModels.filter(({ model }) => {
    if (!isAutoFreeEligibleModelId(model)) return false;
    if (isKiloExclusiveFreeModel(model)) {
      const kiloModel = findKiloExclusiveModel(model);
      return (
        kiloModel !== null &&
        (apiKind === null || kiloModel.provider.supportedChatApis.some(k => k === apiKind))
      );
    }
    return openRouterModels.has(model);
  });
  return eligibleModels.length > 0 ? eligibleModels : [AUTO_FREE_FALLBACK_MODEL];
}

export async function getAutoFreeCandidates(
  apiKind: GatewayRequest['kind'] | null
): Promise<ReadonlyArray<string>> {
  const models = await getEligibleAutoFreeModels(apiKind);
  return models.map(({ model }) => model).toSorted();
}

type OrganizationAutoContext = {
  organizationId?: string;
  settings?: OrganizationSettings;
  plan?: OrganizationPlan;
};

function resolveOrganizationAutoRouteTarget(
  settings: OrganizationSettings,
  modeHeader: string | null
): string | undefined {
  const mode = modeHeader?.trim() ?? '';
  const normalizedMode = mode.toLowerCase();
  const exactRoute = getOrganizationAutoRoute(settings, normalizedMode);

  if (exactRoute) {
    return exactRoute;
  }

  if (normalizedMode === 'build') {
    return getOrganizationAutoRoute(settings, 'code') ?? settings.org_auto_model?.fallback_model;
  }

  if (normalizedMode === 'plan') {
    return (
      getOrganizationAutoRoute(settings, 'architect') ?? settings.org_auto_model?.fallback_model
    );
  }

  return settings.org_auto_model?.fallback_model;
}

export type ResolveAutoModelResult =
  | { kind: 'ok'; resolved: ResolvedAutoModel; routingTarget?: string }
  | { kind: 'no_free_models_available' }
  | { kind: 'organization_auto_configuration_error'; message: string }
  | { kind: 'custom_router_error'; code: CustomRouterErrorCode; message: string }
  | { kind: 'auto_routing_unavailable' };

async function resolveOrganizationAutoModel(
  params: ResolveAutoModelParams,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolveAutoModelResult> {
  const organizationContext: OrganizationAutoContext = await (params.organizationContext ??
    Promise.resolve({}));

  if (!organizationContext.organizationId || organizationContext.plan !== 'enterprise') {
    return {
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto is not available for this account.',
    };
  }

  if (!organizationContext.settings?.org_auto_model) {
    return {
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto is not configured for this organization.',
    };
  }

  if (organizationContext.settings.default_model !== ORG_AUTO_MODEL.id) {
    return {
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto is not enabled for this organization.',
    };
  }

  const targetModelId = resolveOrganizationAutoRouteTarget(
    organizationContext.settings,
    params.modeHeader
  );
  if (!targetModelId) {
    return {
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto has no configured fallback model.',
    };
  }

  let validation: Awaited<ReturnType<typeof validateOrganizationAutoTarget>>;
  try {
    validation = await validateOrganizationAutoTarget(
      {
        id: organizationContext.organizationId,
        plan: organizationContext.plan,
        settings: organizationContext.settings,
      },
      targetModelId,
      { apiKind: params.apiKind ?? undefined }
    );
  } catch {
    return {
      kind: 'organization_auto_configuration_error',
      message:
        'Organization Auto could not validate this route target against the current model catalog.',
    };
  }
  if (validation.kind === 'error') {
    return { kind: 'organization_auto_configuration_error', message: validation.message };
  }

  if (validation.modelId === ORG_AUTO_MODEL.id) {
    // Keep this fail-closed guard at the recursion boundary even though validation rejects self-targets.
    return {
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto cannot target itself.',
    };
  }

  if (
    isOrganizationAutoTargetModel(validation.modelId) ||
    isCustomRouterModelId(validation.modelId)
  ) {
    const nestedResult = await resolveAutoModel(
      {
        ...params,
        model: validation.modelId,
      },
      userPromise,
      balancePromise
    );
    if (nestedResult.kind === 'ok') {
      return { ...nestedResult, routingTarget: validation.modelId };
    }
    return nestedResult;
  }

  return {
    kind: 'ok',
    resolved: { model: validation.modelId },
    routingTarget: validation.modelId,
  };
}

/**
 * Resolve exact catalog variants, rejecting missing variants rather than
 * serving implicit defaults.
 */
export async function resolveCatalogVariant(
  model: string,
  variant: string | null
): Promise<ResolvedAutoModel | null> {
  if (variant === null) return { model };
  const variants = await getModelVariants(model, true);
  const variantSettings: OpenCodeVariant | undefined = variants?.[variant];
  if (!variantSettings) {
    return null;
  }
  return {
    model,
    ...(variantSettings.reasoning ? { reasoning: { ...variantSettings.reasoning } } : {}),
    ...(variantSettings.verbosity ? { verbosity: variantSettings.verbosity } : {}),
  };
}

async function resolveAutoRoutingDecisionModel(
  decision: AutoRoutingDecision
): Promise<ResolvedAutoModel | null> {
  if (decision.variant != null) {
    return await resolveCatalogVariant(decision.model, decision.variant);
  }

  // Legacy effort-only decisions (old workers during rolling deploy).
  return {
    model: decision.model,
    ...(decision.reasoningEffort
      ? { reasoning: { enabled: true, effort: decision.reasoningEffort } }
      : {}),
  };
}

async function resolveCustomRouterModel(
  params: ResolveAutoModelParams,
  reference: CustomRouterReference | null
): Promise<ResolveAutoModelResult> {
  const resolution =
    reference && params.customRouterDecision
      ? await params.customRouterDecision(reference)
      : CUSTOM_ROUTER_NOT_FOUND;
  if (resolution.kind === 'unavailable') return { kind: 'auto_routing_unavailable' };
  if (resolution.kind === 'rejected') {
    return { kind: 'custom_router_error', code: resolution.code, message: resolution.message };
  }
  const resolved = await resolveAutoRoutingDecisionModel(resolution.decision);
  if (!resolved) {
    return {
      kind: 'custom_router_error',
      code: 'custom_router_unavailable',
      message: `The selected variant of ${resolution.decision.model} is not in the model catalog`,
    };
  }
  return { kind: 'ok', resolved };
}

export async function resolveAutoModel(
  params: ResolveAutoModelParams,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolveAutoModelResult> {
  const { model, sessionId, apiKind, clientIp } = params;
  if (model === ORG_AUTO_MODEL.id) {
    return await resolveOrganizationAutoModel(params, userPromise, balancePromise);
  }
  if (isCustomRouterModelId(model)) {
    return await resolveCustomRouterModel(params, parseCustomRouterModelId(model));
  }
  if (model === KILO_AUTO_FREE_MODEL.id) {
    let candidates = await getEligibleAutoFreeModels(apiKind);
    const isCandidateAllowed = params.isAutoFreeCandidateAllowed;
    if (isCandidateAllowed) {
      const decisions = await Promise.all(
        candidates.map(async candidate => ({
          candidate,
          allowed: await isCandidateAllowed(candidate.model),
        }))
      );
      candidates = decisions
        .filter(decision => decision.allowed)
        .map(decision => decision.candidate);
      if (
        candidates.length === 0 &&
        !decisions.some(decision => decision.candidate.model === AUTO_FREE_FALLBACK_MODEL.model) &&
        (await isCandidateAllowed(AUTO_FREE_FALLBACK_MODEL.model))
      ) {
        candidates = [AUTO_FREE_FALLBACK_MODEL];
      }
    }
    if (candidates.length === 0) {
      return { kind: 'no_free_models_available' };
    }
    const selectedCandidate = selectAutoFreeCandidate(
      candidates.toSorted((a, b) => a.model.localeCompare(b.model)),
      'free_routing_' + (sessionId ?? (await userPromise)?.id ?? clientIp)
    );
    return selectedCandidate
      ? {
          kind: 'ok',
          resolved: {
            model: selectedCandidate.model,
            reasoning: { ...selectedCandidate.reasoning },
          },
        }
      : { kind: 'no_free_models_available' };
  }
  if (model === KILO_AUTO_SMALL_MODEL.id) {
    return {
      kind: 'ok',
      resolved: {
        model:
          (await balancePromise) > 0
            ? AUTO_SMALL_TARGET_MODELS.paid
            : AUTO_SMALL_TARGET_MODELS.free,
      },
    };
  }
  if (model === KILO_AUTO_EFFICIENT_MODEL.id || model === KILO_AUTO_BALANCED_MODEL.id) {
    if (params.legacyPoolRouter) {
      let reference: CustomRouterReference | null;
      try {
        reference = await params.legacyPoolRouter();
      } catch {
        return { kind: 'auto_routing_unavailable' };
      }
      if (reference) return resolveCustomRouterModel(params, reference);
    }
    const fallbackModel = { model: PRIMARY_DEFAULT_MODEL };
    let decision: AutoRoutingDecision | null = null;
    if (params.efficientDecision) {
      try {
        decision = await params.efficientDecision();
      } catch {
        return { kind: 'auto_routing_unavailable' };
      }
    }
    if (decision && !isVirtualAutoModelId(decision.model)) {
      const resolvedFromDecision = await resolveAutoRoutingDecisionModel(decision);
      if (resolvedFromDecision) {
        return { kind: 'ok', resolved: resolvedFromDecision };
      }
      // Exact catalog variant missing or removed: never serve the chosen model
      // with implicit defaults — use the same fallback as the no-decision path.
      return { kind: 'ok', resolved: fallbackModel };
    }
    // Static fallback when the worker is slow or unavailable.
    return { kind: 'ok', resolved: fallbackModel };
  }
  if (model === KILO_AUTO_FRONTIER_MODEL.id && params.frontierDecision) {
    const decision = await params.frontierDecision();
    if (decision && !isVirtualAutoModelId(decision.model)) {
      const resolvedFromDecision = await resolveAutoRoutingDecisionModel(decision);
      if (resolvedFromDecision) {
        return { kind: 'ok', resolved: resolvedFromDecision };
      }
    }
  }
  return { kind: 'auto_routing_unavailable' };
}

export async function applyResolvedAutoModel(
  params: ResolveAutoModelParams,
  request: GatewayRequest,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolveAutoModelResult> {
  const result = await resolveAutoModel(params, userPromise, balancePromise);
  if (result.kind === 'ok') {
    applyResolvedModel(request, result.resolved);
  }
  return result;
}

export function applyResolvedModel(request: GatewayRequest, resolved: ResolvedAutoModel): void {
  request.body.model = resolved.model;
  const { reasoning, verbosity } = resolved;
  switch (request.kind) {
    case 'messages':
      if (reasoning) {
        request.body.thinking = { type: reasoning.enabled ? 'adaptive' : 'disabled' };
      }
      if (verbosity) {
        request.body.output_config = { ...request.body.output_config, effort: verbosity };
      }
      return;
    case 'responses':
      if (reasoning) {
        request.body.reasoning = { ...reasoning };
      }
      if (verbosity) {
        request.body.text = {
          ...request.body.text,
          verbosity: verbosity as OpenAI.Responses.ResponseTextConfig['verbosity'],
        };
      }
      return;
    case 'chat_completions':
      if (reasoning) {
        request.body.reasoning = { ...reasoning };
        delete request.body.reasoning_effort;
      }
      if (verbosity) {
        request.body.verbosity = verbosity as OpenRouterChatCompletionRequest['verbosity'];
      }
      return;
    case 'generate_content':
      // The Gemini API has no verbosity setting.
      if (reasoning) {
        request.body.generationConfig = {
          ...request.body.generationConfig,
          thinkingConfig: geminiThinkingConfig(reasoning),
        };
      }
      return;
  }
}

function geminiThinkingConfig(
  reasoning: NonNullable<ResolvedAutoModel['reasoning']>
): NonNullable<GeminiGenerationConfig['thinkingConfig']> {
  if (reasoning.enabled === false || reasoning.effort === 'none') {
    return { thinkingBudget: 0 };
  }
  return {
    ...(reasoning.effort ? { thinkingLevel: reasoning.effort } : {}),
    ...(reasoning.max_tokens ? { thinkingBudget: reasoning.max_tokens } : {}),
  };
}
