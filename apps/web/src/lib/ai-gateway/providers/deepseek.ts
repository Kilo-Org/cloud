import type {
  KiloExclusiveModel,
  Pricing,
  Usage,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isDeepseekModel(model: string) {
  return model.includes('deepseek');
}

function calculate_mUsd(usage: Usage, basePricing: Pricing) {
  return (
    usage.uncachedInputTokens * basePricing.prompt_per_million +
    usage.cacheWriteTokens *
      (basePricing.input_cache_write_per_million ?? basePricing.prompt_per_million) +
    usage.cacheHitTokens *
      (basePricing.input_cache_read_per_million ?? basePricing.prompt_per_million) +
    usage.totalOutputTokens * basePricing.completion_per_million
  );
}

const deepseek_v4_pro_discounted_model: KiloExclusiveModel = {
  public_id: 'deepseek/deepseek-v4-pro:discounted',
  internal_id: 'deepseek/deepseek-v4-pro',
  display_name: 'DeepSeek: DeepSeek V4 Pro (>80% off)',
  description:
    "DeepSeek V4 Pro is a large-scale Mixture-of-Experts model from DeepSeek with 1.6T total parameters and 49B activated parameters, supporting a 1M-token context window. For this discounted endpoint, your prompts and completions may be retained and used to train or improve the provider's services.",
  status: 'public',
  context_length: 1048576,
  max_completion_tokens: 384000,
  gateway: 'vercel', // openrouter seems to be affected by: https://kilo-code.slack.com/archives/C08P0HYC9S4/p1779874852296019
  flags: ['reasoning', 'vision', 'requires-data-collection'],
  pricing: {
    prompt_per_million: 0.435,
    completion_per_million: 0.87,
    input_cache_read_per_million: 0.003625,
    input_cache_write_per_million: null,
    calculate_mUsd,
  },
  exclusive_to: [],
  inference_provider_restriction: ['deepseek'],
};

const deepseek_v4_flash_discounted_model: KiloExclusiveModel = {
  public_id: 'deepseek/deepseek-v4-flash:discounted',
  internal_id: 'deepseek/deepseek-v4-flash',
  display_name: 'DeepSeek: DeepSeek V4 Flash (>40% off)',
  description:
    "DeepSeek V4 Flash is an efficiency-optimized Mixture-of-Experts model from DeepSeek with 284B total parameters and 13B activated parameters, supporting a 1M-token context window. For this discounted endpoint, your prompts and completions may be retained and used to train or improve the provider's services.",
  status: 'public',
  context_length: 1048576,
  max_completion_tokens: 384000,
  gateway: 'vercel',
  flags: ['reasoning', 'vision', 'requires-data-collection'],
  pricing: {
    prompt_per_million: 0.14,
    completion_per_million: 0.28,
    input_cache_read_per_million: 0.0028,
    input_cache_write_per_million: null,
    calculate_mUsd,
  },
  exclusive_to: [],
  inference_provider_restriction: ['deepseek'],
};

export const deepseekDiscountedModels: ReadonlyArray<KiloExclusiveModel> = [
  deepseek_v4_pro_discounted_model,
  deepseek_v4_flash_discounted_model,
];
