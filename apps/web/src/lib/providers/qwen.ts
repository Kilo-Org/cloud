import type { KiloExclusiveModel, Pricing, Usage } from '@/lib/providers/kilo-exclusive-model';

const QWEN_256K_THRESHOLD = 256 * 1024;

// Tier 1 pricing (<= 256k total input) - 35% lower than standard rates
const qwenTier1Pricing: Pricing = {
  prompt: 0.000000325,
  completion: 0.00000195,
  input_cache_read: 0.0000000325,
  input_cache_write: 0.00000040625,
  calculate_mUsd(usage: Usage, pricing: Pricing): number {
    const inputCost = usage.inputTokens * pricing.prompt;
    const outputCost = usage.outputTokens * pricing.completion;
    const cacheReadCost =
      pricing.input_cache_read !== null ? usage.cacheHitTokens * pricing.input_cache_read : 0;
    const cacheWriteCost =
      pricing.input_cache_write !== null ? usage.cacheWriteTokens * pricing.input_cache_write : 0;
    return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1000000);
  },
};

// Tier 2 pricing (> 256k total input) - 35% lower than standard rates
const qwenTier2Pricing: Pricing = {
  prompt: 0.0000013,
  completion: 0.0000039,
  input_cache_read: 0.00000013,
  input_cache_write: 0.000001625,
  calculate_mUsd(usage: Usage, pricing: Pricing): number {
    const inputCost = usage.inputTokens * pricing.prompt;
    const outputCost = usage.outputTokens * pricing.completion;
    const cacheReadCost =
      pricing.input_cache_read !== null ? usage.cacheHitTokens * pricing.input_cache_read : 0;
    const cacheWriteCost =
      pricing.input_cache_write !== null ? usage.cacheWriteTokens * pricing.input_cache_write : 0;
    return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1000000);
  },
};

export function calculateQwen36PlusCost(usage: Usage): number {
  const totalInput = usage.inputTokens + usage.cacheWriteTokens + usage.cacheHitTokens;
  const pricing = totalInput <= QWEN_256K_THRESHOLD ? qwenTier1Pricing : qwenTier2Pricing;
  return pricing.calculate_mUsd(usage, pricing);
}

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
    calculate_mUsd: calculateQwen36PlusCost,
  },
};
