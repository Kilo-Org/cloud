import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/claude-model';
import { isOpenAiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openai';
import { isGrokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/xai';
import type { OpenCodePrompt, OpenCodeSettings, ReasoningOption } from '@kilocode/db/schema-types';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';
import { isMuseModel } from '@kilocode/web-shared/lib/ai-gateway/providers/meta';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  findVercelOnlyModels,
  fromVercelReasoningOptions,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/find-vercel-only-models';
import {
  effortOptions,
  getFallbackReasoningOptions,
  REASONING_TOGGLE,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import { toLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';

function resolveCatalogModelId(models: GatewayModelMap, model: string): string {
  return Object.hasOwn(models, model) ? model : normalizeModelId(model);
}

export async function getOpenRouterReasoningOptions(
  model: string
): Promise<ReasoningOption[] | undefined> {
  return reasoningOptionsFor(await getOpenRouterModelsMetadataFromDatabase(), model);
}

function reasoningOptionsFor(
  models: GatewayModelMap,
  model: string
): ReasoningOption[] | undefined {
  // A suffixed id such as `:free` has no metadata of its own and resolves to its base id.
  const resolvedModelId = resolveCatalogModelId(models, model);
  const reasoning = models[resolvedModelId]?.reasoning;
  if (!reasoning) {
    return undefined;
  }
  if (!reasoning.supported_efforts?.length) {
    return reasoning.mandatory ? [] : REASONING_TOGGLE;
  }
  const efforts = new Set(reasoning.supported_efforts);
  if (
    !reasoning.mandatory &&
    // Kimi does not support non-reasoning despite what OpenRouter says
    // https://huggingface.co/moonshotai/Kimi-K3#6-model-usage
    normalizeModelId(resolvedModelId) !== 'moonshotai/kimi-k3'
  ) {
    efforts.add('none');
  }
  return effortOptions(...ReasoningEffortSchema.options.filter(effort => efforts.has(effort)));
}

/**
 * Vercel's reasoning options for a model the catalog lists because only Vercel AI Gateway serves
 * it. Undefined for models OpenRouter lists, including those without reasoning metadata.
 */
async function getVercelOnlyReasoningOptions(
  models: GatewayModelMap,
  model: string
): Promise<ReasoningOption[] | undefined> {
  const openRouterModelIds = Object.keys(models);
  if (
    // Without OpenRouter's models, every Vercel model would look Vercel-only.
    openRouterModelIds.length === 0 ||
    Object.hasOwn(models, resolveCatalogModelId(models, model))
  ) {
    return undefined;
  }
  const [vercelModels, overrides] = await Promise.all([
    getVercelModelsMetadataFromDatabase(),
    getVercelModelIdOverrides(),
  ]);
  const vercelModel = vercelModels[mapResolvedModelIdToVercel(model, overrides)];
  const [vercelOnlyModel] = vercelModel
    ? findVercelOnlyModels({
        openRouterModelIds,
        vercelMetadata: { [vercelModel.id]: vercelModel },
        overrides,
      })
    : [];
  return vercelOnlyModel?.id === model
    ? fromVercelReasoningOptions(vercelOnlyModel.storedModel.reasoning_options)
    : undefined;
}

export async function getModelReasoningOptions(
  model: string,
  allowFallback: boolean
): Promise<ReasoningOption[] | undefined> {
  const openRouterModels = await getOpenRouterModelsMetadataFromDatabase();
  return (
    reasoningOptionsFor(openRouterModels, model) ??
    (await getVercelOnlyReasoningOptions(openRouterModels, model)) ??
    (allowFallback ? getFallbackReasoningOptions(model) : undefined)
  );
}

export async function getModelVariants(
  model: string,
  allowFallback: boolean
): Promise<OpenCodeSettings['variants']> {
  return (await getGatewayOpenCodeSettings(model, allowFallback)).variants;
}

// OpenRouter is the default, so a model with no AI SDK provider of its own gets `undefined`.
export function getAiSdkProvider(model: string): 'anthropic' | 'openai' | undefined {
  if (isClaudeModel(model)) {
    return 'anthropic';
  }
  if (isOpenAiModel(model) || isGrokModel(model) || isMuseModel(model)) {
    // OpenAI: "While Chat Completions remains supported, Responses is recommended for all new projects."
    // xAI: "The Responses API is the recommended way to interact with xAI models."
    return 'openai';
  }
  return undefined;
}

function getOpenCodePrompt(model: string): OpenCodePrompt | undefined {
  if (model.includes('gpt-5.5')) {
    return 'gpt55';
  }
  return undefined;
}

export async function getGatewayOpenCodeSettings(
  model: string,
  allowFallback: boolean
): Promise<OpenCodeSettings> {
  const ai_sdk_provider = getAiSdkProvider(model);
  const reasoning_options = await getModelReasoningOptions(model, allowFallback);
  const variants = toLegacyVariants(reasoning_options, ai_sdk_provider);
  const prompt = getOpenCodePrompt(model);
  return { ai_sdk_provider, variants, reasoning_options, prompt };
}
