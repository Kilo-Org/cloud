import 'server-only';

import {
  GEMMA_4_26B_A4B_IT_ID,
  GEMMA_4_26B_A4B_IT_FREE_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import type { KiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
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
};

export const kiloExclusiveModels = [gemma_4_26b_a4b_it_free_model] as KiloExclusiveModel[];

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model) ?? null;
}

export function isKiloExclusiveModel(model: string): boolean {
  return findKiloExclusiveModel(model) !== null;
}
