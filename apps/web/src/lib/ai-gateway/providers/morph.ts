import type {
  KiloExclusiveModel,
  Pricing,
  PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

// Large open-source models served on Morph's own inference fleet and exposed
// through Morph's OpenAI-compatible gateway (https://api.morphllm.com/v1).
//
// `internal_id` is the model id Morph's gateway expects; `public_id` is the
// Kilo-facing id. Requests route to the MORPH provider via `gateway: 'morph'`
// (see provider-definitions.ts and get-provider.ts). Kilo holds the key
// (MORPH_API_KEY); this is the gateway integration, not BYOK.
//
// Pricing (per 1M tokens) and context windows mirror Morph's published numbers
// (landing/src/lib/pricing.ts + MODEL_CONTEXT_WINDOWS). Keep in sync.

function flat(pricing: Pricing): PricingTiers {
  return [{ start_context_length: 0, pricing }];
}

export const morph_qwen35_397b_model: KiloExclusiveModel = {
  public_id: 'morph/qwen3.5-397b',
  display_name: 'Morph: Qwen3.5 397B',
  description: 'Qwen3.5 397B (A17B), served on Morph infrastructure.',
  context_length: 262_144,
  max_completion_tokens: 131_072,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'morph',
  internal_id: 'morph-qwen35-397b',
  pricing: flat({
    prompt_per_million: 0.5,
    completion_per_million: 3.5,
    input_cache_read_per_million: 0.3,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const morph_qwen36_27b_model: KiloExclusiveModel = {
  public_id: 'morph/qwen3.6-27b',
  display_name: 'Morph: Qwen3.6 27B',
  description: 'Qwen3.6 27B, served on Morph infrastructure.',
  context_length: 131_072,
  max_completion_tokens: 131_072,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'morph',
  internal_id: 'morph-qwen36-27b',
  pricing: flat({
    prompt_per_million: 0.289,
    completion_per_million: 2.4,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const morph_minimax_m27_model: KiloExclusiveModel = {
  public_id: 'morph/minimax-m2.7',
  display_name: 'Morph: MiniMax M2.7',
  description: 'MiniMax M2.7 (230B A10B), served on Morph infrastructure.',
  context_length: 196_608,
  max_completion_tokens: 196_608,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'morph',
  internal_id: 'morph-minimax27-230b',
  pricing: flat({
    prompt_per_million: 0.279,
    completion_per_million: 1.2,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const morph_minimax_m3_model: KiloExclusiveModel = {
  public_id: 'morph/minimax-m3',
  display_name: 'Morph: MiniMax M3',
  description: 'MiniMax M3 (428B A23B), served on Morph infrastructure.',
  context_length: 256_000,
  max_completion_tokens: 256_000,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'morph',
  internal_id: 'morph-minimax3-428b',
  pricing: flat({
    prompt_per_million: 0.6,
    completion_per_million: 2.4,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const morph_glm52_744b_model: KiloExclusiveModel = {
  public_id: 'morph/glm-5.2',
  display_name: 'Morph: GLM-5.2',
  description: 'GLM-5.2 744B, served on Morph infrastructure.',
  context_length: 1_048_576,
  max_completion_tokens: 1_048_576,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'morph',
  internal_id: 'morph-glm52-744b',
  pricing: flat({
    prompt_per_million: 1.1,
    completion_per_million: 4.1,
    // GLM-5.2 runs LMCache prefix reuse, so cached input bills at a cheaper
    // read rate (Morph's calculateChatGlm52Cost). The other Morph chat models
    // do not bill cache reads, hence null on those.
    input_cache_read_per_million: 0.35,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const morph_dsv4flash_model: KiloExclusiveModel = {
  public_id: 'morph/deepseek-v4-flash',
  display_name: 'Morph: DeepSeek V4 Flash',
  description: 'DeepSeek V4 Flash (1M context), served on Morph infrastructure.',
  context_length: 1_048_576,
  max_completion_tokens: 1_048_576,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'morph',
  internal_id: 'morph-dsv4flash',
  pricing: flat({
    prompt_per_million: 0.139,
    completion_per_million: 0.278,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const morphChatModels: KiloExclusiveModel[] = [
  morph_qwen35_397b_model,
  morph_qwen36_27b_model,
  morph_minimax_m27_model,
  morph_minimax_m3_model,
  morph_glm52_744b_model,
  morph_dsv4flash_model,
];

export function isMorphModel(model: string): boolean {
  return model.startsWith('morph/');
}
