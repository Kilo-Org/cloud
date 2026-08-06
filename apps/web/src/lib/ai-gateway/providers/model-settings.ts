import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { isQwenModel } from '@/lib/ai-gateway/providers/qwen';
import { isGrokModel } from '@/lib/ai-gateway/providers/xai';
import type {
  CustomLlmProvider,
  OpenCodePrompt,
  OpenCodeSettings,
  OpenCodeVariant,
} from '@kilocode/db/schema-types';
import { VerbositySchema } from '@kilocode/db/schema-types';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isMuseModel } from '@/lib/ai-gateway/providers/meta';
import { getOpenRouterModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import {
  getFallbackModelVariants,
  REASONING_VARIANTS_THINKING_ONLY,
  REASONING_VARIANTS_BINARY,
} from '@/lib/ai-gateway/providers/variants';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';

export async function getOpenRouterDerivedModelVariants(
  model: string
): Promise<OpenCodeSettings['variants']> {
  const models = await getOpenRouterModelsMetadataFromDatabase();
  const reasoning = (models[model] ?? models[normalizeModelId(model)])?.reasoning;
  if (!reasoning) {
    return undefined;
  }
  if (!reasoning.supported_efforts?.length) {
    return reasoning.mandatory ? REASONING_VARIANTS_THINKING_ONLY : REASONING_VARIANTS_BINARY;
  }
  const useAnthropicProvider = getAiSdkProvider(model, null) === 'anthropic';
  const variants: [string, OpenCodeVariant][] = reasoning.supported_efforts
    .toReversed()
    .map(effort => [
      effort,
      {
        reasoning: { enabled: effort !== 'none', effort },
        verbosity: useAnthropicProvider ? VerbositySchema.safeParse(effort).data : undefined,
      },
    ]);
  if (!reasoning.mandatory && !variants.some(([effort]) => effort === 'none')) {
    variants.unshift(['none', { reasoning: { enabled: false, effort: 'none' } }]);
  }
  return Object.fromEntries(variants);
}

export async function getModelVariants(
  model: string,
  allowFallbackVariants: boolean
): Promise<OpenCodeSettings['variants']> {
  return (
    (await getOpenRouterDerivedModelVariants(model)) ??
    (allowFallbackVariants ? getFallbackModelVariants(model) : undefined)
  );
}

export function getAiSdkProvider(
  model: string,
  directProviderId: DirectUserByokInferenceProviderId | null
): Exclude<CustomLlmProvider, 'openrouter' /*the default*/> | undefined {
  if (directProviderId === 'morph-byok') {
    return 'openai-compatible';
  }
  if (directProviderId === 'opencode-go' && (isMinimaxModel(model) || isQwenModel(model))) {
    return 'anthropic';
  }
  if (
    isClaudeModel(model) || // on Vercel AI Gateway, this is necessary to support document attachments
    (!directProviderId && isMinimaxModel(model)) // on Vercel AI Gateway, this is necessary for reasoning to show
  ) {
    return 'anthropic';
  }
  if (isOpenAiModel(model) || isGrokModel(model) || isMuseModel(model)) {
    // OpenAI: "While Chat Completions remains supported, Responses is recommended for all new projects.""
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
  allowFallbackVariants: boolean
): Promise<OpenCodeSettings | undefined> {
  const ai_sdk_provider = getAiSdkProvider(model, null);
  const variants = await getModelVariants(model, allowFallbackVariants);
  const prompt = getOpenCodePrompt(model);
  return { ai_sdk_provider, variants, prompt };
}
