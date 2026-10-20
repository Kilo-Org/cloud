import { getAiSdkProvider } from '@kilocode/worker-utils/ai-sdk-provider';
import type { OpenCodePrompt, OpenCodeSettings, ReasoningOption } from '@kilocode/db/schema-types';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  effortOptions,
  getFallbackReasoningOptions,
  REASONING_TOGGLE,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import { toLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';

export async function getOpenRouterReasoningOptions(
  model: string
): Promise<ReasoningOption[] | undefined> {
  const models = await getOpenRouterModelsMetadataFromDatabase();
  const reasoning = (models[model] ?? models[normalizeModelId(model)])?.reasoning;
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
    model !== 'moonshotai/kimi-k3'
  ) {
    efforts.add('none');
  }
  return effortOptions(...ReasoningEffortSchema.options.filter(effort => efforts.has(effort)));
}

export async function getModelReasoningOptions(
  model: string,
  allowFallback: boolean
): Promise<ReasoningOption[] | undefined> {
  return (
    (await getOpenRouterReasoningOptions(model)) ??
    (allowFallback ? getFallbackReasoningOptions(model) : undefined)
  );
}

export async function getModelVariants(
  model: string,
  allowFallback: boolean
): Promise<OpenCodeSettings['variants']> {
  return toLegacyVariants(
    await getModelReasoningOptions(model, allowFallback),
    getAiSdkProvider(model, null)
  );
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
): Promise<OpenCodeSettings | undefined> {
  const ai_sdk_provider = getAiSdkProvider(model, null);
  const reasoning_options = await getModelReasoningOptions(model, allowFallback);
  const variants = toLegacyVariants(reasoning_options, ai_sdk_provider);
  const prompt = getOpenCodePrompt(model);
  return { ai_sdk_provider, variants, reasoning_options, prompt };
}
