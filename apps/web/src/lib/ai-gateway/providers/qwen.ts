import type {
  KiloExclusiveModel,
  Pricing,
  Usage,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

const standardCalculate_mUsd = (usage: Usage, basePricing: Pricing): number =>
  usage.uncachedInputTokens * basePricing.prompt_per_million +
  usage.totalOutputTokens * basePricing.completion_per_million +
  usage.cacheHitTokens *
    (basePricing.input_cache_read_per_million ?? basePricing.prompt_per_million) +
  usage.cacheWriteTokens *
    (basePricing.input_cache_write_per_million ?? basePricing.prompt_per_million);

export const qwen36_plus_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-plus',
  display_name: 'Qwen: Qwen3.6 Plus',
  description:
    'The Qwen3.6 native vision-language Plus series models demonstrate exceptional performance on par with the current state-of-the-art models, with a significant improvement in overall results compared to the 3.5 series. The models have been markedly enhanced in code-related capabilities such as agentic coding, front-end programming, and Vibe coding, as well as in multi-modal general object recognition, OCR, and object localization. Note: a surcharge applies to long-context workloads exceeding 256K input tokens.',
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-plus',
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
  exclusive_to: [],
};

export const qwen36_flash_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-flash',
  display_name: 'Qwen: Qwen3.6 Flash',
  description:
    "Qwen3.6 Flash is a fast, efficient language model from Alibaba's Qwen 3.6 series. It supports text, image, and video input with a 1M token context window. Tiered pricing kicks in for long-context workloads.",
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-flash',
  pricing: {
    prompt_per_million: 0.25,
    completion_per_million: 1.5,
    input_cache_read_per_million: null,
    input_cache_write_per_million: 0.3125,
    calculate_mUsd: standardCalculate_mUsd,
  },
  exclusive_to: [],
};

export const qwen36_35b_a3b_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-35b-a3b',
  display_name: 'Qwen: Qwen3.6 35B A3B',
  description:
    'Qwen3.6-35B-A3B is an open-weight multimodal model from Alibaba Cloud with 35 billion total parameters and 3 billion active parameters per token. It uses a hybrid sparse mixture-of-experts architecture combining Gated attention layers, and supports text, image, and video inputs with a 262K token context window.',
  context_length: 262144,
  max_completion_tokens: 65536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-35b-a3b',
  pricing: {
    prompt_per_million: 0.1612,
    completion_per_million: 0.96525,
    input_cache_read_per_million: 0.1612,
    input_cache_write_per_million: null,
    calculate_mUsd: standardCalculate_mUsd,
  },
  exclusive_to: [],
};

export const qwen36_max_preview_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-max-preview',
  display_name: 'Qwen: Qwen3.6 Max Preview',
  description:
    'Qwen3.6-Max-Preview is a proprietary frontier model from Alibaba Cloud built on a sparse mixture-of-experts architecture with approximately 1 trillion total parameters. It is optimized for agentic coding, tool use, and long-context reasoning.',
  context_length: 262144,
  max_completion_tokens: 65536,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-max-preview',
  pricing: {
    prompt_per_million: 1.04,
    completion_per_million: 6.24,
    input_cache_read_per_million: null,
    input_cache_write_per_million: 1.3,
    calculate_mUsd: standardCalculate_mUsd,
  },
  exclusive_to: [],
};

export const qwen36_27b_model: KiloExclusiveModel = {
  public_id: 'qwen/qwen3.6-27b',
  display_name: 'Qwen: Qwen3.6 27B',
  description:
    'Qwen3.6 27B is a dense 27-billion-parameter language model from the Qwen Team at Alibaba, released in April 2026. It features hybrid multimodal capabilities — accepting text, image, and video inputs with a 256K token context window.',
  context_length: 256000,
  max_completion_tokens: 65536,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-27b',
  pricing: {
    prompt_per_million: 0.325,
    completion_per_million: 3.25,
    input_cache_read_per_million: null,
    input_cache_write_per_million: null,
    calculate_mUsd: standardCalculate_mUsd,
  },
  exclusive_to: [],
};
