import type {
  KiloExclusiveModel,
  Pricing,
  PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

const KILO_DISCOUNT_FACTOR = 0.65;
const KILO_STEALTH_DISCOUNT_FACTOR = 0.5;

function applyKiloDiscount(price: Pricing, discountFactor: number = KILO_DISCOUNT_FACTOR): Pricing {
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
  discountFactor: number = KILO_DISCOUNT_FACTOR
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

function makeFlatPricing(pricing: Pricing): PricingTiers {
  return [{ start_context_length: 0, pricing: applyKiloDiscount(pricing) }];
}

const TOKENS_128K = 128 * 1024;
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
  pricing: makeFlatPricing({
    prompt_per_million: 2.5,
    completion_per_million: 7.5,
    input_cache_read_per_million: 0.25,
    input_cache_write_per_million: 3.125,
  }),
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
  pricing: makeTieredPricing([
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
      start_context_length: TOKENS_256K + 1,
      pricing: {
        prompt_per_million: 1.2,
        completion_per_million: 4.8,
        input_cache_read_per_million: 0.12,
        input_cache_write_per_million: 1.5,
      },
    },
  ]),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const qwen37_plus_free_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.7-plus:free',
  display_name: 'Qwen: Qwen3.7 Plus (free)',
  description:
    "Qwen3.7-Plus is Alibaba's native multimodal agent model for visual-language reasoning, agentic coding, tool use, and productivity workflows. It supports text, image, and video inputs. For this free endpoint, your prompts and completions may be retained and used to train or improve the provider's services.",
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'disabled',
  flags: ['reasoning', 'vision', 'requires-data-collection'],
  gateway: 'vercel',
  internal_id: 'alibaba/qwen3.7-plus',
  pricing: null,
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const qwen36_plus_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-plus',
  display_name: 'Qwen: Qwen3.6 Plus',
  description:
    'The Qwen3.6 native vision-language Plus series models demonstrate exceptional performance on par with the current state-of-the-art models, with a significant improvement in overall results compared to the 3.5 series. The models have been markedly enhanced in code-related capabilities such as agentic coding, front-end programming, and Vibe coding, as well as in multi-modal general object recognition, OCR, and object localization. Note: a surcharge applies to long-context workloads exceeding 256K input tokens.',
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-plus',
  pricing: makeTieredPricing([
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
      start_context_length: TOKENS_256K + 1,
      pricing: {
        prompt_per_million: 2,
        completion_per_million: 6,
        input_cache_read_per_million: 0.2,
        input_cache_write_per_million: 2.5,
      },
    },
  ]),
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
        start_context_length: TOKENS_256K + 1,
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

export const qwen36_flash_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-flash',
  display_name: 'Qwen: Qwen3.6 Flash',
  description:
    'The Qwen3.6 native vision-language Flash model series delivers a significant performance boost over the 3.5-Flash version. This model particularly excels in agentic coding capabilities, substantially outperforming its predecessor on multiple code-agent benchmarks, as well as in mathematical and code reasoning. In terms of vision, it features markedly improved spatial intelligence, with especially notable enhancements in object localization and object detection. Note: a surcharge applies to long-context workloads exceeding 256K input tokens.',
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-flash',
  pricing: makeTieredPricing([
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 0.25,
        completion_per_million: 1.5,
        input_cache_read_per_million: 0.025,
        input_cache_write_per_million: 0.3125,
      },
    },
    {
      start_context_length: TOKENS_256K + 1,
      pricing: {
        prompt_per_million: 1,
        completion_per_million: 4,
        input_cache_read_per_million: 0.1,
        input_cache_write_per_million: 1.25,
      },
    },
  ]),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const qwen36_max_preview_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-max-preview',
  display_name: 'Qwen: Qwen3.6 Max Preview',
  description:
    'The Max model, the largest and most capable variant in the Qwen3.6 series, is now available in a preview version. At present, only its plain-text capabilities are open for experimentation. Compared with the previously released Qwen3-Max and Qwen3.6-Plus, this model features enhanced vibe coding abilities, more efficient coding agent execution, and significantly improved front-end development skills. Additionally, its long-tail knowledge retention has been further upgraded. Note: a surcharge applies to long-context workloads exceeding 128K input tokens.',
  context_length: 262_144,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-max-preview',
  pricing: makeTieredPricing([
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 1.3,
        completion_per_million: 7.8,
        input_cache_read_per_million: 0.13,
        input_cache_write_per_million: 1.625,
      },
    },
    {
      start_context_length: TOKENS_128K + 1,
      pricing: {
        prompt_per_million: 2,
        completion_per_million: 12,
        input_cache_read_per_million: 0.2,
        input_cache_write_per_million: 2.5,
      },
    },
  ]),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const qwen36_27b_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-27b',
  display_name: 'Qwen: Qwen3.6 27B',
  description:
    'Qwen3.6 27B is a dense 27-billion-parameter language model from the Qwen Team at Alibaba. It features hybrid multimodal capabilities — accepting text, image, and video inputs with a 256K token context window.',
  context_length: 256_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-27b',
  pricing: makeFlatPricing({
    prompt_per_million: 0.5,
    completion_per_million: 5,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
  }),
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const alibabaDirectModels: ReadonlyArray<KiloExclusiveModel> = [
  qwen37_max_model,
  qwen37_plus_model,
  qwen36_plus_model,
  qwen36_flash_model,
  qwen36_max_preview_model,
  qwen36_27b_model,
];

const alibabaDirectModelIds: ReadonlySet<string> = new Set(
  alibabaDirectModels.map(m => m.public_id)
);

export function isAlibabaDirectModel(model: string): boolean {
  return alibabaDirectModelIds.has(model);
}
