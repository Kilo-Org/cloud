import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isGemmaModel(model: string) {
  return model.includes('gemma');
}

export const GEMMA_4_26B_A4B_IT_ID = 'google/gemma-4-26b-a4b-it';

export const gemma_4_26b_a4b_it_free_model: KiloExclusiveModel = {
  public_id: 'google/gemma-4-26b-a4b-it:free',
  display_name: 'Google: Gemma 4 26B A4B (free)',
  description:
    'Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference — delivering near-31B quality at a fraction of the compute cost.',
  context_length: 262144,
  max_completion_tokens: 32768,
  status: 'hidden', // usable through kilo-auto
  flags: ['vision', 'vercel-routing'],
  gateway: 'openrouter',
  internal_id: GEMMA_4_26B_A4B_IT_ID,
  pricing: null,
  exclusive_to: [],
  inference_provider_restriction: [],
};

export function isGemini3Model(model: string) {
  return model.includes('gemini-3');
}

export const GEMINI_PRO_CURRENT_MODEL_ID = 'google/gemini-3.1-pro-preview';

export const GEMINI_PRO_CURRENT_VERCEL_MODEL_ID = GEMINI_PRO_CURRENT_MODEL_ID;

export const GEMINI_FLASH_CURRENT_MODEL_ID = 'google/gemini-3.5-flash';

export const GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID = GEMINI_FLASH_CURRENT_MODEL_ID;
