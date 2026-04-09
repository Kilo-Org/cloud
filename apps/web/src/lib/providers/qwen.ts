import type { KiloExclusiveModel, Pricing, Usage } from '@/lib/providers/kilo-exclusive-model';

export const qwen36_plus_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-plus',
  display_name: 'Qwen: Qwen3.6 Plus',
  description:
    'The Qwen3.6 native vision-language Plus series models demonstrate exceptional performance on par with the current state-of-the-art models, with a significant improvement in overall results compared to the 3.5 series. The models have been markedly enhanced in code-related capabilities such as agentic coding, front-end programming, and Vibe coding, as well as in multi-modal general object recognition, OCR, and object localization.',
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'disabled',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-plus',
  inference_provider: 'alibaba',
  pricing: {
    prompt: 0.000000325,
    completion: 0.00000195,
    input_cache_read: 0.0000000325,
    input_cache_write: 0.00000040625,
    calculate: (usage: Usage, basePricing: Pricing) => {
      const totalInput = usage.uncachedInputTokens + usage.cacheWriteTokens + usage.cacheHitTokens;
      if (totalInput > 256 * 1024) {
        return (
          usage.uncachedInputTokens * 0.0000013 +
          usage.totalOutputTokens * 0.0000039 +
          usage.cacheHitTokens * 0.00000013 +
          usage.cacheWriteTokens * 0.000001625
        );
      }
      return (
        usage.uncachedInputTokens * basePricing.prompt +
        usage.totalOutputTokens * basePricing.completion +
        usage.cacheHitTokens * (basePricing.input_cache_read ?? basePricing.prompt) +
        usage.cacheWriteTokens * (basePricing.input_cache_write ?? basePricing.prompt)
      );
    },
  },
};
