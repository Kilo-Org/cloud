import * as z from 'zod';
import { GEMINI_THOUGHT_TAG_MARKER } from '@kilocode/web-shared/lib/ai-gateway/reasoning-details-transform';
import {
  isOpenRouterProviderConfig,
  type GatewayResponsesRequest,
  type OpenRouterChatCompletionRequest,
  type GatewayRequest,
  type GatewayMessagesRequest,
  type OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  applyMistralModelSettings,
  isMistralModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';
import {
  findKiloExclusiveModel,
  isKiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { applyVercelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { applyKiloExclusiveModelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyAnthropicModelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import {
  isGatewayUserByokProviderId,
  OpenRouterInferenceProviderIdSchema,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  applyMoonshotModelSettings,
  isKimiModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/moonshotai';
import { resolvePreferredProviderOrder } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';
import { getPreferredProviderOrderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config';
import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import {
  ReasoningDetailsTransform,
  type BYOKResult,
  type Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { FraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { isFreeModelExcludingCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { applyTrackingIds } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  repairChatCompletionsTools,
  repairMessagesTools,
  sanitizeBinaryToolResults,
} from '@kilocode/web-shared/lib/ai-gateway/tool-calling';
import { fixOpenCodeDuplicateReasoning } from '@kilocode/web-shared/lib/ai-gateway/providers/fixOpenCodeDuplicateReasoning';
import {
  addCacheBreakpoints,
  enableReasoningSummaries,
  fixResponsesRequest,
  mapReasoningDetailsToReasoning,
  mapReasoningDetailsToReasoningContent,
  replaceReasoningObjectWithReasoningEffort,
  scrubOpenCodeSpecificProperties,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { isQwenExplicitCacheModel } from '@kilocode/web-shared/lib/ai-gateway/providers/qwen';
import { ReasoningFormat } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/format';
import { ReasoningDetailType } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/reasoning-details';
import type { CustomPricing } from '@kilocode/db/schema-types';
import { getCustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { sanitizeJsonRefToolResults } from '@kilocode/web-shared/lib/ai-gateway/providers/sanitize-json-ref-tool-results';
import { isMuseModel } from '@kilocode/web-shared/lib/ai-gateway/providers/meta';
import { removeRecursiveToolSchemaRefs } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-recursive-tool-schema-refs';
import { removeTopLevelToolSchemaCombinators } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-top-level-tool-schema-combinators';
import { removePaidServerFeatures } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-paid-server-features';
import {
  addReflectionReasoningPlaceholders,
  isReflectionModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reflection';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setGeminiThoughtSignature(value: Record<string, unknown>, signature: string) {
  const extraContent = isRecord(value.extra_content) ? value.extra_content : {};
  const google = isRecord(extraContent.google) ? extraContent.google : {};
  value.extra_content = {
    ...extraContent,
    google: {
      ...google,
      thought_signature: signature,
    },
  };
}

function mapGeminiReasoningDetails(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    if (!isRecord(message)) {
      continue;
    }

    delete message.thoughtSignature;
    delete message.reasoning;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
    for (const toolCall of toolCalls) {
      const legacySignature = toolCall.thoughtSignature;
      delete toolCall.thoughtSignature;
      if (typeof legacySignature === 'string') {
        setGeminiThoughtSignature(toolCall, legacySignature);
      }
    }

    const reasoningDetails = message.reasoning_details;
    delete message.reasoning_details;
    if (!Array.isArray(reasoningDetails)) {
      continue;
    }

    for (const detail of reasoningDetails) {
      if (
        !isRecord(detail) ||
        detail.type !== ReasoningDetailType.Encrypted ||
        typeof detail.data !== 'string' ||
        detail.format !== ReasoningFormat.GoogleGeminiV1
      ) {
        continue;
      }

      const toolCall =
        typeof detail.id === 'string'
          ? toolCalls.find(candidate => candidate.id === detail.id)
          : undefined;
      setGeminiThoughtSignature(toolCall ?? message, detail.data);
    }
  }
}

function applyGeminiReasoningTransform(request: OpenRouterChatCompletionRequest) {
  const reasoningEffort = request.reasoning_effort;
  const extra = request as typeof request & { google?: unknown };
  delete extra.reasoning_effort;

  if (reasoningEffort !== 'none') {
    const existingGoogle = isRecord(extra.google) ? extra.google : {};
    extra.google = {
      ...existingGoogle,
      thinking_config: {
        ...(reasoningEffort !== undefined ? { thinking_level: reasoningEffort } : {}),
        include_thoughts: true,
      },
      // Without streaming, thoughts and answer share one content string, and
      // only these tags separate them. Streams flag thought chunks instead, and
      // asking for tags there would also put the closing tag in the answer.
      ...(request.stream !== true ? { thought_tag_marker: GEMINI_THOUGHT_TAG_MARKER } : {}),
    };
  }

  mapGeminiReasoningDetails(request);
}

/**
 * Claude goes to Anthropic directly only for non-trial enterprise
 * organizations; everyone else is served by the other Claude providers.
 */
export function getIgnoredProviders(
  requestedModel: string,
  isAnthropicProviderAllowed: boolean
): string[] {
  if (!isAnthropicProviderAllowed && isClaudeModel(requestedModel)) {
    return [OpenRouterInferenceProviderIdSchema.enum.anthropic];
  }
  return [];
}

export function withIgnoredProviders(
  provider: OpenRouterProviderConfig | undefined,
  ignoredProviders: string[]
): OpenRouterProviderConfig | undefined {
  if (ignoredProviders.length === 0) {
    return provider;
  }
  return { ...provider, ignore: [...new Set([...(provider?.ignore ?? []), ...ignoredProviders])] };
}

export function applyPreferredProvider(
  preferredProviderOrderConfig: PreferredProviderOrderConfig,
  requestedModel: string,
  requestToMutate:
    | OpenRouterChatCompletionRequest
    | GatewayResponsesRequest
    | GatewayMessagesRequest,
  isAnthropicProviderAllowed: boolean
) {
  const preferredProviderOrder = resolvePreferredProviderOrder(
    preferredProviderOrderConfig,
    requestedModel
  );
  const ignoredProviders = getIgnoredProviders(requestedModel, isAnthropicProviderAllowed);
  if (preferredProviderOrder.length === 0 && ignoredProviders.length === 0) {
    return;
  }
  const provider = isOpenRouterProviderConfig(requestToMutate.provider)
    ? requestToMutate.provider
    : {};
  if (preferredProviderOrder.length > 0 && !provider.order) {
    console.debug(
      `[applyPreferredProvider] Preferentially routing ${requestedModel} to ${preferredProviderOrder.join()}`
    );
    provider.order = preferredProviderOrder;
  }
  requestToMutate.provider = withIgnoredProviders(provider, ignoredProviders);
}

/**
 * Fallback models are not supported: a request for a free model could fall
 * back to a paid model and be served without being charged. OpenRouter accepts
 * them as `models` on every API and as `fallbacks` on the Messages API.
 */
export function removeModelsFallback(requestedModel: string, requestToMutate: GatewayRequest) {
  const { models, fallbacks } = requestToMutate.body;
  delete requestToMutate.body.models;
  delete requestToMutate.body.fallbacks;

  if (!hasFallbackModels(models) && !hasFallbackModels(fallbacks)) {
    return;
  }
  console.warn('[applyProviderSpecificLogic] Removed caller-provided fallback models', {
    model: requestedModel,
    requestKind: requestToMutate.kind,
    modelsPresent: hasFallbackModels(models),
    modelsCount: Array.isArray(models) ? models.length : null,
    fallbacksPresent: hasFallbackModels(fallbacks),
    fallbacksCount: Array.isArray(fallbacks) ? fallbacks.length : null,
  });
}

function hasFallbackModels(value: unknown) {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

/**
 * Service tiers the log may name. Every other value, including non-strings and
 * names inherited from `Object.prototype`, is recorded as `unrecognized` rather
 * than as the client-supplied value.
 */
const loggedServiceTierSchema = z.enum(['auto', 'default', 'flex', 'priority', 'scale']);

function serviceTierForLog(serviceTier: unknown) {
  const parsed = loggedServiceTierSchema.safeParse(serviceTier);
  return parsed.success ? parsed.data : 'unrecognized';
}

export function removeUnsupportedRequestServiceTier(
  requestedModel: string,
  requestToMutate: GatewayRequest,
  customPricing: CustomPricing | undefined
) {
  const reason =
    customPricing && !customPricing.fallbackOnly
      ? 'non-fallback custom pricing'
      : isKiloExclusiveModel(requestedModel)
        ? 'Kilo-exclusive model'
        : null;
  const serviceTier = requestToMutate.body.service_tier;
  if (!reason || serviceTier === undefined) {
    return;
  }

  console.warn('[applyProviderSpecificLogic] Removed unsupported request-level service tier', {
    model: requestedModel,
    requestKind: requestToMutate.kind,
    serviceTier: serviceTierForLog(serviceTier),
    reason,
  });
  delete requestToMutate.body.service_tier;
}

/**
 * Inverse of the reasoning-content and reasoning response transforms: folds
 * client-supplied `reasoning_details` back into the `reasoning_content` or
 * `reasoning` string the upstream speaks, so reasoning survives the round trip.
 * These upstreams are OpenAI-compatible, so OpenRouter's `reasoning` object is
 * also replaced with `reasoning_effort`.
 */
export function applyReasoningDetailsTransform(
  provider: Provider,
  requestToMutate: GatewayRequest
) {
  if (requestToMutate.kind !== 'chat_completions') {
    return;
  }

  switch (provider.responseTransforms) {
    case ReasoningDetailsTransform.GeminiThought:
      applyGeminiReasoningTransform(requestToMutate.body);
      break;
    case ReasoningDetailsTransform.ReasoningContent:
      replaceReasoningObjectWithReasoningEffort(requestToMutate);
      mapReasoningDetailsToReasoningContent(requestToMutate.body);
      break;
    case ReasoningDetailsTransform.Reasoning:
      replaceReasoningObjectWithReasoningEffort(requestToMutate);
      mapReasoningDetailsToReasoning(requestToMutate.body);
      break;
    case null:
      break;
  }
}

export async function applyProviderSpecificLogic(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null,
  originalHeaders: FraudDetectionHeaders,
  userId: string,
  organizationId: string | null,
  sessionId: string | null,
  taskId: string | null,
  isNonTrialEnterprise: boolean
) {
  // A user's own gateway key bills their account, so Kilo's routing preferences
  // do not override what the request and their account ask for, and the
  // gateway's paid server features bill that account rather than Kilo's.
  const usesUserGatewayKey =
    userByok?.some(byok => isGatewayUserByokProviderId(byok.providerId)) ?? false;

  removeModelsFallback(requestedModel, requestToMutate);
  if (
    isFreeModelExcludingCustomLlms(requestedModel) ||
    (userByok !== null && !usesUserGatewayKey)
  ) {
    removePaidServerFeatures(provider, requestedModel, requestToMutate, userId);
  }
  applyTrackingIds(requestToMutate, provider, userId, taskId);

  sanitizeBinaryToolResults(requestToMutate);

  if (isGeminiModel(requestedModel)) {
    sanitizeJsonRefToolResults(requestToMutate);
  }

  if (isMuseModel(requestedModel)) {
    // Meta rejects tools with "Recursive JSON schemas are not currently supported"
    removeRecursiveToolSchemaRefs(requestToMutate);
  }

  if (isClaudeModel(requestedModel)) {
    // Anthropic rejects tools with "input_schema does not support oneOf, allOf, or anyOf at the top level"
    removeTopLevelToolSchemaCombinators(requestToMutate);
  }

  if (requestToMutate.kind === 'chat_completions') {
    scrubOpenCodeSpecificProperties(requestToMutate.body);

    repairChatCompletionsTools(requestToMutate.body);

    if (isClaudeModel(requestedModel)) {
      // Workaround for older clients corrupting Claude reasoning, resulting in:
      // `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified
      fixOpenCodeDuplicateReasoning(requestedModel, requestToMutate.body, taskId ?? undefined);
    }
  }

  if (requestToMutate.kind === 'messages') {
    repairMessagesTools(requestToMutate.body);
  }

  if (requestToMutate.kind === 'responses') {
    fixResponsesRequest(requestToMutate.body);
  }

  enableReasoningSummaries(requestToMutate);

  removeUnsupportedRequestServiceTier(
    requestedModel,
    requestToMutate,
    getCustomPricing(await getCustomPricingConfig(), requestedModel)
  );
  const kiloExclusiveModel = findKiloExclusiveModel(requestedModel);
  if (kiloExclusiveModel) {
    applyKiloExclusiveModelSettings(requestToMutate, kiloExclusiveModel);
  }

  if (isClaudeModel(requestedModel)) {
    applyAnthropicModelSettings(requestToMutate, extraHeaders);
  }

  if (!usesUserGatewayKey && (provider.id === 'openrouter' || provider.id === 'vercel')) {
    // A user's own BYOK credential is never ignored.
    applyPreferredProvider(
      await getPreferredProviderOrderConfig(),
      requestedModel,
      requestToMutate.body,
      isNonTrialEnterprise || userByok !== null
    );
  }

  if (isKimiModel(requestedModel)) {
    applyMoonshotModelSettings(requestToMutate);
  }

  if (isMistralModel(requestedModel)) {
    applyMistralModelSettings(requestToMutate);
  }

  if (isQwenExplicitCacheModel(requestedModel)) {
    addCacheBreakpoints(requestToMutate);
  }

  if (isReflectionModel(requestedModel)) {
    addReflectionReasoningPlaceholders(requestedModel, requestToMutate);
  }

  if (provider.id === 'vercel') {
    // A user's own Vercel AI Gateway key is shaped like a managed request: the
    // user's account pays and the provider routing settings still apply.
    await applyVercelSettings(
      requestedModel,
      requestToMutate,
      usesUserGatewayKey ? null : userByok
    );
  }

  await provider.transformRequest({
    provider,
    model: requestedModel,
    request: requestToMutate,
    originalHeaders,
    extraHeaders,
    userByok,
    kilo_user_id: userId,
    organization_id: organizationId,
    session_id: sessionId,
  });

  applyReasoningDetailsTransform(provider, requestToMutate);
}
