import type { FeatureValue } from '@/lib/feature-detection';
import {
  gemma_4_26b_a4b_it_free_model,
  GEMMA_4_26B_A4B_IT_ID,
} from '@/lib/ai-gateway/providers/google';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type OpenAI from 'openai';
import type { User } from '@kilocode/db';
import type {
  OrganizationPlan,
  OrganizationSettings,
} from '@/lib/organizations/organization-types';
import { isVirtualAutoModelId, type AutoRoutingDecision } from '@kilocode/auto-routing-contracts';
import {
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  modeSchema,
  BALANCED_CLAW_SETUP_MODEL,
  BALANCED_QWEN_MODEL,
  FRONTIER_MODE_TO_MODEL,
  FRONTIER_CODE_MODEL,
  type ResolvedAutoModel,
  KILO_AUTO_LEGACY_MODEL,
  ORG_AUTO_MODEL,
} from '@/lib/ai-gateway/auto-model';
import { userIsWithinFirstKiloClawInstanceWindow } from '@/lib/kiloclaw/setup-promo';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import {
  autoFreeModels,
  findKiloExclusiveModel,
  isKiloExclusiveFreeModel,
} from '@/lib/ai-gateway/models';
import { getOpenRouterModels } from '@/lib/ai-gateway/providers/gateway-models-cache';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import {
  getOrganizationAutoRoute,
  isOrganizationAutoTargetModel,
  validateOrganizationAutoTarget,
} from '@/lib/organizations/organization-auto-model';

type ResolveAutoModelParams = {
  model: string;
  modeHeader: string | null;
  featureHeader: FeatureValue | null;
  sessionId: string | null;
  apiKind: GatewayRequest['kind'] | null;
  clientIp: string | null;
  // Lazily fetches the auto-routing worker's decision; only set for
  // kilo-auto/efficient requests (route.ts owns the request-body capture).
  efficientDecision?: () => Promise<AutoRoutingDecision | null>;
  organizationContext?: Promise<{
    organizationId?: string;
    settings?: OrganizationSettings;
    plan?: OrganizationPlan;
  }>;
};

function resolveMode(modeHeader: string | null, featureHeader: FeatureValue | null) {
  const parsedMode = modeSchema.safeParse(modeHeader?.trim() ?? '');
  if (parsedMode.success) return parsedMode.data;
  if (featureHeader === 'kiloclaw' || featureHeader === 'openclaw') return 'claw' as const;
  return null;
}

/**
 * Returns the candidate models for kilo-auto/free routing.
 *
 * Non-kilo-exclusive free models are only included when they appear in the
 * supplied `openRouterModels` list (sourced from the Redis OpenRouter models
 * cache). Kilo-exclusive free models are included when their gateway supports
 * the current `apiKind`; when `apiKind` is null no API-kind filtering is applied.
 */
export async function getAutoFreeCandidates(
  apiKind: GatewayRequest['kind'] | null
): Promise<ReadonlyArray<string>> {
  const openRouterModels = await getOpenRouterModels();
  const candidates = new Set<string>();
  for (const model of autoFreeModels) {
    if (isKiloExclusiveFreeModel(model)) {
      const kiloModel = findKiloExclusiveModel(model);
      if (kiloModel && gatewaySupportsApiKind(kiloModel.gateway, apiKind)) {
        candidates.add(model);
      }
    } else if (openRouterModels.has(model)) {
      candidates.add(model);
    }
  }
  return [...candidates].toSorted();
}

function gatewaySupportsApiKind(
  gateway: ProviderId,
  apiKind: GatewayRequest['kind'] | null
): boolean {
  if (apiKind === null) return true;
  const provider = Object.values(PROVIDERS).find(p => p.id === gateway);
  return provider?.supportedChatApis.some(k => k === apiKind) ?? false;
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
  | { kind: 'organization_auto_configuration_error'; message: string };

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

  if (isOrganizationAutoTargetModel(validation.modelId)) {
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

export async function resolveAutoModel(
  params: ResolveAutoModelParams,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolveAutoModelResult> {
  const { model, modeHeader, featureHeader, sessionId, apiKind, clientIp } = params;
  if (model === ORG_AUTO_MODEL.id) {
    return await resolveOrganizationAutoModel(params, userPromise, balancePromise);
  }
  if (model === KILO_AUTO_FREE_MODEL.id) {
    const candidates = await getAutoFreeCandidates(apiKind);
    if (candidates.length === 0) {
      return { kind: 'no_free_models_available' };
    }
    const randomNumber = getRandomNumber(
      'free_routing_' + (sessionId ?? (await userPromise)?.id ?? clientIp),
      candidates.length
    );
    return { kind: 'ok', resolved: { model: candidates[randomNumber] } };
  }
  if (model === KILO_AUTO_SMALL_MODEL.id) {
    return {
      kind: 'ok',
      resolved: {
        model:
          (await balancePromise) > 0
            ? GEMMA_4_26B_A4B_IT_ID
            : gemma_4_26b_a4b_it_free_model.public_id,
      },
    };
  }
  if (model === KILO_AUTO_EFFICIENT_MODEL.id) {
    const decision = params.efficientDecision ? await params.efficientDecision() : null;
    if (decision && !isVirtualAutoModelId(decision.model)) {
      // Apply the candidate's pinned reasoning effort so the model runs under
      // the same conditions the benchmark measured it at.
      return {
        kind: 'ok',
        resolved: {
          model: decision.model,
          ...(decision.reasoningEffort
            ? { reasoning: { enabled: true, effort: decision.reasoningEffort } }
            : {}),
        },
      };
    }
    // Static fallback when the worker is slow/unavailable: same model as
    // balanced so an efficient request never degrades below balanced.
    return { kind: 'ok', resolved: BALANCED_QWEN_MODEL };
  }
  const mode = resolveMode(modeHeader, featureHeader);
  if (model === KILO_AUTO_BALANCED_MODEL.id || model === KILO_AUTO_LEGACY_MODEL) {
    if (mode === 'claw' && featureHeader === 'kiloclaw') {
      const user = await userPromise;
      if (user && (await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id }))) {
        return { kind: 'ok', resolved: BALANCED_CLAW_SETUP_MODEL };
      }
    }

    return { kind: 'ok', resolved: BALANCED_QWEN_MODEL };
  }
  return {
    kind: 'ok',
    resolved: (mode !== null ? FRONTIER_MODE_TO_MODEL[mode] : null) ?? FRONTIER_CODE_MODEL,
  };
}

export async function applyResolvedAutoModel(
  params: ResolveAutoModelParams,
  request: GatewayRequest,
  userPromise: Promise<User | null>,
  balancePromise: Promise<number>
): Promise<ResolveAutoModelResult> {
  const result = await resolveAutoModel(params, userPromise, balancePromise);
  if (result.kind !== 'ok') {
    return result;
  }
  const resolved = result.resolved;
  request.body.model = resolved.model;
  if (resolved.reasoning) {
    if (request.kind === 'messages') {
      request.body.thinking = { type: resolved.reasoning.enabled ? 'adaptive' : 'disabled' };
    } else {
      request.body.reasoning = { ...resolved.reasoning };
    }
  }
  if (resolved.verbosity) {
    if (request.kind === 'messages') {
      request.body.output_config = {
        ...request.body.output_config,
        effort: resolved.verbosity,
      };
    } else if (request.kind === 'responses') {
      request.body.text = {
        ...request.body.text,
        verbosity: resolved.verbosity as OpenAI.Responses.ResponseTextConfig['verbosity'],
      };
    } else {
      request.body.verbosity = resolved.verbosity as OpenRouterChatCompletionRequest['verbosity'];
    }
  }
  return result;
}
