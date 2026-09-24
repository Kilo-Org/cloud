import 'server-only';

import {
  CLAUDE_OPUS_4_8_STEALTH_MODEL_ID,
  CLAUDE_OPUS_STEALTH_MODEL_ID,
  CLAUDE_SONNET_STEALTH_MODEL_ID,
  CLAUDE_OPUS_4_6_STEALTH_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  GEMMA_4_26B_A4B_IT_ID,
  GEMMA_4_26B_A4B_IT_FREE_ID,
} from '@/lib/ai-gateway/providers/google';
import type {
  KiloExclusiveModel,
  Pricing,
  PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { type ProviderId } from '@/lib/ai-gateway/providers/types';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';

const CLAUDE_OPUS_STEALTH_PRICING: PricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 4,
      completion_per_million: 20,
      input_cache_read_per_million: 0.4,
      input_cache_write_per_million: 5,
    },
  },
];

export const claude_opus_4_8_stealth_model: KiloExclusiveModel = {
  public_id: CLAUDE_OPUS_4_8_STEALTH_MODEL_ID,
  internal_id: 'anthropic/claude-opus-4-8:optimized',
  display_name: 'Stealth: Claude Opus 4.8 (20% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Claude Opus 4.8 is offered at 20% lower cost than standard Claude Opus 4.8 pricing and is not served by Anthropic or Kilo Code.",
  status: 'public',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  provider: MARTIAN,
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: { tiers: CLAUDE_OPUS_STEALTH_PRICING },
  inference_provider_restriction: [],
};

export const claude_opus_4_7_stealth_model: KiloExclusiveModel = {
  public_id: CLAUDE_OPUS_STEALTH_MODEL_ID,
  internal_id: 'anthropic/claude-opus-4-7:optimized',
  display_name: 'Stealth: Claude Opus 4.7 (20% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Claude Opus 4.7 is offered at 20% lower cost than standard Claude Opus 4.7 pricing and is not served by Anthropic or Kilo Code.",
  status: 'public',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  provider: MARTIAN,
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: { tiers: CLAUDE_OPUS_STEALTH_PRICING },
  inference_provider_restriction: [],
};

const CLAUDE_SONNET_STEALTH_PRICING: PricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 2.4,
      completion_per_million: 12,
      input_cache_read_per_million: 0.24,
      input_cache_write_per_million: 3,
    },
  },
];

export const claude_sonnet_4_6_stealth_model: KiloExclusiveModel = {
  public_id: CLAUDE_SONNET_STEALTH_MODEL_ID,
  internal_id: 'anthropic/claude-sonnet-4-6:optimized',
  display_name: 'Stealth: Claude Sonnet 4.6 (20% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Claude Sonnet 4.6 is offered at 20% lower cost than standard Claude Sonnet 4.6 pricing and is not served by Anthropic or Kilo Code.",
  status: 'public',
  context_length: 1_000_000,
  max_completion_tokens: 64_000,
  provider: MARTIAN,
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: { tiers: CLAUDE_SONNET_STEALTH_PRICING },
  inference_provider_restriction: [],
};

export const claude_opus_4_6_stealth_model: KiloExclusiveModel = {
  public_id: CLAUDE_OPUS_4_6_STEALTH_MODEL_ID,
  internal_id: 'anthropic/claude-opus-4-6:optimized',
  display_name: 'Stealth: Claude Opus 4.6 (20% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Claude Opus 4.6 is offered at 20% lower cost than standard Claude Opus 4.6 pricing and is not served by Anthropic or Kilo Code.",
  status: 'public',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  provider: MARTIAN,
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: { tiers: CLAUDE_OPUS_STEALTH_PRICING },
  inference_provider_restriction: [],
};

export const gemma_4_26b_a4b_it_free_model: KiloExclusiveModel = {
  public_id: GEMMA_4_26B_A4B_IT_FREE_ID,
  display_name: 'Google: Gemma 4 26B A4B (free)',
  description:
    'Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference — delivering near-31B quality at a fraction of the compute cost.',
  context_length: 262144,
  max_completion_tokens: 32768,
  status: 'hidden', // usable through kilo-auto
  flags: ['vision', 'vercel-routing', 'rate-limited'],
  provider: OPENROUTER,
  internal_id: GEMMA_4_26B_A4B_IT_ID,
  pricing: null,
  inference_provider_restriction: [],
};

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

export const qwen36_plus_stealth_model: KiloExclusiveModel = {
  public_id: 'stealth/qwen3.6-plus',
  display_name: 'Stealth: Qwen3.6 Plus (50% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Qwen3.6 Plus is offered at 50% lower cost than standard Qwen3.6 Plus pricing and is not served by Alibaba or Kilo Code. Note: a surcharge applies to long-context workloads exceeding 256K input tokens.",
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  status: 'public',
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  provider: MARTIAN,
  internal_id: 'qwen/qwen3.6-plus',
  pricing: {
    tiers: makeTieredPricing(
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
  },
  inference_provider_restriction: [],
};

export const stepfun_37_flash_free_model: KiloExclusiveModel = {
  public_id: 'stepfun/step-3.7-flash:free',
  display_name: 'StepFun: Step 3.7 Flash (free)',
  description:
    "Step 3.7 Flash is StepFun's latest high-efficiency multimodal Mixture-of-Experts model. It pairs a 196B-parameter language backbone with a vision encoder for native image and video understanding, activating roughly 11B parameters per token. The model supports a 256K context window and exposes selectable reasoning levels (high/medium/low), letting callers trade off speed, cost, and depth of reasoning.\n\nDesigned for coding, agentic workflows, structured outputs, and long-context productivity tasks.",
  context_length: 262_144,
  max_completion_tokens: 262_144,
  status: 'public',
  flags: ['reasoning', 'vision', 'vercel-routing'],
  provider: OPENROUTER,
  internal_id: 'stepfun/step-3.7-flash',
  pricing: null,
  inference_provider_restriction: ['stepfun'],
};

export function isKiloExclusiveFreeModel(model: string): boolean {
  return kiloExclusiveModels.some(
    m => m.public_id === model && m.status !== 'disabled' && !m.pricing
  );
}

export function isKiloExclusiveModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.status !== 'disabled');
}

export function isKiloExclusiveRateLimitedModel(model: string): boolean {
  return kiloExclusiveModels.some(
    m => m.public_id === model && m.status !== 'disabled' && m.flags.includes('rate-limited')
  );
}

export const kiloExclusiveModels = [
  gemma_4_26b_a4b_it_free_model,
  qwen36_plus_stealth_model,
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  stepfun_37_flash_free_model,
] as KiloExclusiveModel[];

export function isKiloStealthModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.flags.includes('stealth'));
}

export function shouldRedactModelNameInMicrodollarUsage(
  provider: ProviderId,
  model: string
): boolean {
  return provider === 'custom' || isKiloStealthModel(model);
}

export function shouldRedactErrorResponse(provider: ProviderId, model: string): boolean {
  return isKiloStealthModel(model);
}

export function isDisabledKiloExclusiveModel(model: string): boolean {
  return !!kiloExclusiveModels.find(m => m.public_id === model && m.status === 'disabled');
}

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model && m.status !== 'disabled') ?? null;
}

/**
 * Routing allow-list for a live exclusive model. `undefined` means the model is
 * not a restricted exclusive and catalog provider metadata should be used.
 */
export function getKiloExclusiveInferenceProviderRestriction(
  modelId: string
): ReadonlySet<string> | undefined {
  const exclusive = findKiloExclusiveModel(modelId);
  if (!exclusive || exclusive.inference_provider_restriction.length === 0) {
    return undefined;
  }
  return new Set(exclusive.inference_provider_restriction);
}
