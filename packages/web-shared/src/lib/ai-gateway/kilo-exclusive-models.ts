import 'server-only';

import {
  GEMMA_4_26B_A4B_IT_ID,
  GEMMA_4_26B_A4B_IT_FREE_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import {
  isStealthModel,
  type KiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import { type ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';

export const gemma_4_26b_a4b_it_free_model: KiloExclusiveModel = {
  public_id: GEMMA_4_26B_A4B_IT_FREE_ID,
  display_name: 'Google: Gemma 4 26B A4B (free)',
  description:
    'Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference — delivering near-31B quality at a fraction of the compute cost.',
  context_length: 262144,
  max_completion_tokens: 32768,
  flags: ['vision', 'vercel-routing'],
  provider: OPENROUTER,
  internal_id: GEMMA_4_26B_A4B_IT_ID,
  inference_providers: [],
};

export const kiloExclusiveModels = [gemma_4_26b_a4b_it_free_model] as KiloExclusiveModel[];

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model) ?? null;
}

export function isKiloExclusiveModel(model: string): boolean {
  return findKiloExclusiveModel(model) !== null;
}

export function isKiloStealthModel(model: string): boolean {
  const exclusive = findKiloExclusiveModel(model);
  return exclusive !== null && isStealthModel(exclusive);
}

export function shouldRedactModelNameInMicrodollarUsage(
  provider: ProviderId,
  model: string
): boolean {
  return provider === 'custom' || isKiloStealthModel(model);
}

export function shouldRedactErrorResponse(provider: ProviderId, model: string): boolean {
  return isKiloStealthModel(model);
}

/**
 * Inference providers of an exclusive model. `undefined` means the model is
 * not an exclusive with explicit providers and catalog provider metadata should be used.
 */
export function getKiloExclusiveInferenceProviders(
  modelId: string
): ReadonlySet<string> | undefined {
  const exclusive = findKiloExclusiveModel(modelId);
  if (!exclusive || exclusive.inference_providers.length === 0) {
    return undefined;
  }
  return new Set(exclusive.inference_providers);
}
