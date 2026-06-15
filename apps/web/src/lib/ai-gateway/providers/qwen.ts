import type {
  KiloExclusiveModel,
  Pricing,
  PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

const KILO_STEALTH_DISCOUNT_FACTOR = 0.5;

function applyKiloDiscount(price: Pricing, discountFactor: number): Pricing {
  return {
    prompt_per_million: price.prompt_per_million * discountFactor,
    completion_per_million: price.completion_per_million * discountFactor,
    input_cache_read_per_million:
      price.input_cache_read_per_million === null
        ? null
        : price.input_cache_read_per_million * discountFactor,
    input_cache_write_per_million:
      price.input_cache_write_per_million === null
        ? null
        : price.input_cache_write_per_million * discountFactor,
  };
}

type UndiscountedPricingTier = {
  start_context_length: number;
  pricing: Pricing;
};

function makeTieredPricing(
  tiers: readonly [UndiscountedPricingTier, ...UndiscountedPricingTier[]],
  discountFactor: number
): PricingTiers {
  const [firstTier, ...remainingTiers] = tiers;
  return [
    {
      start_context_length: firstTier.start_context_length,
      pricing: applyKiloDiscount(firstTier.pricing, discountFactor),
    },
    ...remainingTiers.map(tier => ({
      start_context_length: tier.start_context_length,
      pricing: applyKiloDiscount(tier.pricing, discountFactor),
    })),
  ];
}

const TOKENS_256K = 256 * 1024;

export const QWEN37_MAX_MODEL_ID = 'qwen/qwen3.7-max';
export const QWEN37_PLUS_MODEL_ID = 'qwen/qwen3.7-plus';

export const qwen36_plus_stealth_model: KiloExclusiveModel = {
  public_id: 'stealth/qwen3.6-plus',
  display_name: 'Stealth: Qwen3.6 Plus (50% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Qwen3.6 Plus is offered at 50% lower cost than standard Qwen3.6 Plus pricing and is not served by Alibaba or Kilo Code. Note: a surcharge applies to long-context workloads exceeding 256K input tokens.",
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  gateway: 'martian',
  internal_id: 'qwen/qwen3.6-plus',
  pricing: makeTieredPricing(
    [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 0.5,
          completion_per_million: 3,
          input_cache_read_per_million: 0.05,
          input_cache_write_per_million: 0.625,
        },
      },
      {
        start_context_length: TOKENS_256K,
        pricing: {
          prompt_per_million: 2,
          completion_per_million: 6,
          input_cache_read_per_million: 0.2,
          input_cache_write_per_million: 2.5,
        },
      },
    ],
    KILO_STEALTH_DISCOUNT_FACTOR
  ),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export function isQwenModel(model: string) {
  return model.includes('qwen');
}

export function isQwenExplicitCacheModel(model: string) {
  return (
    (model.includes('qwen3.7') || model.includes('qwen3.6')) &&
    (model.includes('max') || model.includes('plus'))
  );
}
