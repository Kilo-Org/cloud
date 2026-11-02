import { KILO_AUTO_FREE_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { isFreeVercelModel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/free-vercel-models';

/** Whether Kilo charges nothing for the model. Custom LLMs are always free. */
export async function isFreeModel(modelId: string): Promise<boolean> {
  return (await isCustomLlm(modelId)) || (await isFreeGatewayModel(modelId));
}

/**
 * The built-in free model rules plus free Vercel-only models, without custom LLMs. Prefer it over
 * `isFreeModelExcludingCustomLlms` on chat routes, where Vercel-only models are served.
 */
export async function isFreeGatewayModel(modelId: string): Promise<boolean> {
  return isFreeModelExcludingCustomLlms(modelId) || (await isFreeVercelModel(modelId));
}

/**
 * The built-in free model rules, without custom LLMs. Use `isFreeModel` unless
 * custom LLMs need separate handling, as for `kilo-auto/free` candidates.
 */
export function isFreeModelExcludingCustomLlms(model: string): boolean {
  const modelId = model ?? '';
  return (
    isKiloExclusiveModel(modelId) ||
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      isLocalFakeLlmEnabled()) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId.endsWith(':free') ||
    modelId === 'openrouter/free' ||
    (modelId.startsWith('stealth/') && modelId.endsWith('-alpha'))
  );
}

/** Free models, custom LLMs included, are assumed to train on prompts. */
export async function hasBestEffortGuessDataCollectionRequirement(model: string): Promise<boolean> {
  return await isFreeModel(model);
}
