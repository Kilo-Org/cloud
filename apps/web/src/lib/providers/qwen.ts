import type { KiloExclusiveModel, Pricing, Usage } from '@/lib/providers/kilo-exclusive-model';

export const qwen36_plus_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-plus',
  display_name: 'Qwen: Qwen3.6 Plus',
  description:
    'The Qwen3.6 native vision-language Plus series models demonstrate exceptional performance on par with the current state-of-the-art models, with a significant improvement in overall results compared to the 3.5 series. The models have been markedly enhanced in code-related capabilities such as agentic coding, front-end programming, and Vibe coding, as well as in multi-modal general object recognition, OCR, and object localization.',
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-plus',
  inference_provider: 'alibaba',
  pricing: {
    prompt_per_million: 0.325,
    completion_per_million: 1.95,
    input_cache_read_per_million: 0.0325,
    input_cache_write_per_million: 0.40625,
    calculate_mUsd: (usage: Usage, basePricing: Pricing) => {
      const totalInput = usage.uncachedInputTokens + usage.cacheWriteTokens + usage.cacheHitTokens;
      if (totalInput > 256 * 1024) {
        return (
          usage.uncachedInputTokens * 1.3 +
          usage.totalOutputTokens * 3.9 +
          usage.cacheHitTokens * 0.13 +
          usage.cacheWriteTokens * 1.625
        );
      }
      return (
        usage.uncachedInputTokens * basePricing.prompt_per_million +
        usage.totalOutputTokens * basePricing.completion_per_million +
        usage.cacheHitTokens *
          (basePricing.input_cache_read_per_million ?? basePricing.prompt_per_million) +
        usage.cacheWriteTokens *
          (basePricing.input_cache_write_per_million ?? basePricing.prompt_per_million)
      );
    },
  },
};
