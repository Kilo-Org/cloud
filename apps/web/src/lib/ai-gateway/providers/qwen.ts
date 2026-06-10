import type {
  KiloExclusiveModel,
  Pricing,
  PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

const DEFAULT_QWEN_DISCOUNT_FACTOR = 1;
const QWEN37_PLUS_DISCOUNT_FACTOR = 0.8;
const QWEN37_MAX_DISCOUNT_FACTOR = 0.5;
const KILO_STEALTH_DISCOUNT_FACTOR = 0.5;

function applyKiloDiscount(
  price: Pricing,
  discountFactor: number = DEFAULT_QWEN_DISCOUNT_FACTOR
): Pricing {
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
  discountFactor: number = DEFAULT_QWEN_DISCOUNT_FACTOR
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

function makeFlatPricing(
  pricing: Pricing,
  discountFactor: number = DEFAULT_QWEN_DISCOUNT_FACTOR
): PricingTiers {
  return [{ start_context_length: 0, pricing: applyKiloDiscount(pricing, discountFactor) }];
}

const TOKENS_256K = 256 * 1024;

export const qwen37_max_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.7-max',
  display_name: 'Qwen: Qwen3.7 Max',
  description:
    "Qwen3.7-Max is the flagship model in Alibaba's Qwen3.7 series. It is designed for agent-centric workloads, with particular strengths in coding, office and productivity tasks, and long-horizon autonomous execution.",
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'alibaba',
  internal_id: 'qwen3.7-max',
  pricing: makeFlatPricing(
    {
      prompt_per_million: 2.5,
      completion_per_million: 7.5,
      input_cache_read_per_million: 0.25,
      input_cache_write_per_million: 3.125,
    },
    QWEN37_MAX_DISCOUNT_FACTOR
  ),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const qwen37_plus_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.7-plus',
  display_name: 'Qwen: Qwen3.7 Plus',
  description:
    "Qwen3.7-Plus is Alibaba's native multimodal agent model for visual-language reasoning, agentic coding, tool use, and productivity workflows. It supports text, image, and video inputs. Note: a surcharge applies to long-context workloads exceeding 256K input tokens.",
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.7-plus',
  pricing: makeTieredPricing(
    [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 0.4,
          completion_per_million: 1.6,
          input_cache_read_per_million: 0.04,
          input_cache_write_per_million: 0.5,
        },
      },
      {
        start_context_length: TOKENS_256K,
        pricing: {
          prompt_per_million: 1.2,
          completion_per_million: 4.8,
          input_cache_read_per_million: 0.12,
          input_cache_write_per_million: 1.5,
        },
      },
    ],
    QWEN37_PLUS_DISCOUNT_FACTOR
  ),
  exclusive_to: [],
  inference_provider_restriction: [],
};

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

export const alibabaDirectModels: ReadonlyArray<KiloExclusiveModel> = [
  qwen37_max_model,
  qwen37_plus_model,
];

const alibabaDirectModelIds: ReadonlySet<string> = new Set(
  alibabaDirectModels.map(m => m.public_id)
);

export function isAlibabaDirectModel(model: string): boolean {
  return alibabaDirectModelIds.has(model);
}

export function isQwenModel(model: string) {
  return model.includes('qwen');
}

export function isQwenExplicitCacheModel(model: string) {
  return (
    (model.includes('qwen3.7') || model.includes('qwen3.6')) &&
    (model.includes('max') || model.includes('plus'))
  );
}
