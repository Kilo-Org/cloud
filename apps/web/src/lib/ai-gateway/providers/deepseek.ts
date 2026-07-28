import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isDeepseekModel(model: string) {
  return model.includes('deepseek');
}

export const deepseek_v4_pro_discounted_model: KiloExclusiveModel = {
  public_id: 'deepseek/deepseek-v4-pro:discounted',
  internal_id: 'deepseek/deepseek-v4-pro',
  display_name: 'DeepSeek: DeepSeek V4 Pro (lowest price)',
  description:
    'This DeepSeek V4 Pro endpoint provides the lowest cost for multi-turn conversations for this model. This is accomplished with an exceptionally low cache read price. By using this endpoint you agree prompts and completions may be retained by DeepSeek and used to train future models.',
  status: 'public',
  context_length: 1048576,
  max_completion_tokens: 384000,
  gateway: 'openrouter',
  flags: ['reasoning', 'requires-data-collection', 'vercel-routing'],
  pricing: [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 0.435,
        completion_per_million: 0.87,
        input_cache_read_per_million: 0.003625,
        input_cache_write_per_million: null,
      },
    },
  ],
  inference_provider_restriction: ['deepseek'],
};

const deepseek_v4_flash_discounted_model: KiloExclusiveModel = {
  public_id: 'deepseek/deepseek-v4-flash:discounted',
  internal_id: 'deepseek/deepseek-v4-flash',
  display_name: 'DeepSeek: DeepSeek V4 Flash (lowest price)',
  description:
    'This DeepSeek V4 Flash endpoint provides the lowest cost for multi-turn conversations for this model. This is accomplished with an exceptionally low cache read price. By using this endpoint you agree prompts and completions may be retained by DeepSeek and used to train future models.',
  status: 'public',
  context_length: 1048576,
  max_completion_tokens: 384000,
  gateway: 'openrouter',
  flags: ['reasoning', 'requires-data-collection', 'vercel-routing'],
  pricing: [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 0.14,
        completion_per_million: 0.28,
        input_cache_read_per_million: 0.0028,
        input_cache_write_per_million: null,
      },
    },
  ],
  inference_provider_restriction: ['deepseek'],
};

export const deepseekDiscountedModels: ReadonlyArray<KiloExclusiveModel> = [
  deepseek_v4_pro_discounted_model,
  deepseek_v4_flash_discounted_model,
];
