import type {
  KiloExclusiveModel,
  Pricing,
  Usage,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.7';
export const CLAUDE_HAIKU_CURRENT_MODEL_ID = 'anthropic/claude-haiku-4.5';
export const CLAUDE_OPUS_STEALTH_MODEL_ID = 'stealth/claude-opus-4.7';
export const CLAUDE_SONNET_STEALTH_MODEL_ID = 'stealth/claude-sonnet-4.6';
export const CLAUDE_OPUS_4_6_STEALTH_MODEL_ID = 'stealth/claude-opus-4.6';

export const CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID = CLAUDE_SONNET_CURRENT_MODEL_ID;
export const CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID = CLAUDE_OPUS_CURRENT_MODEL_ID;
export const CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID = CLAUDE_HAIKU_CURRENT_MODEL_ID;

const CLAUDE_OPUS_STEALTH_PRICING: Pricing = {
  prompt_per_million: 4,
  completion_per_million: 20,
  input_cache_read_per_million: 0.4,
  input_cache_write_per_million: 5,
  calculate_mUsd: (usage: Usage) =>
    usage.uncachedInputTokens * 4 +
    usage.totalOutputTokens * 20 +
    usage.cacheHitTokens * 0.4 +
    usage.cacheWriteTokens * 5,
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
  gateway: 'martian',
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: CLAUDE_OPUS_STEALTH_PRICING,
  exclusive_to: [],
  inference_provider_restriction: [],
};

const CLAUDE_SONNET_STEALTH_PRICING: Pricing = {
  prompt_per_million: 2.4,
  completion_per_million: 12,
  input_cache_read_per_million: 0.24,
  input_cache_write_per_million: 3,
  calculate_mUsd: (usage: Usage) =>
    usage.uncachedInputTokens * 2.4 +
    usage.totalOutputTokens * 12 +
    usage.cacheHitTokens * 0.24 +
    usage.cacheWriteTokens * 3,
};

export const claude_sonnet_4_6_stealth_model: KiloExclusiveModel = {
  public_id: CLAUDE_SONNET_STEALTH_MODEL_ID,
  internal_id: 'anthropic/claude-sonnet-4-6:optimized',
  display_name: 'Stealth: Claude Sonnet 4.6 (20% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of Claude Sonnet 4.6 is offered at 20% lower cost than standard Claude Sonnet 4.6 pricing and is not served by Anthropic or Kilo Code.",
  status: 'public',
  context_length: 1_000_000,
  max_completion_tokens: 64_000,
  gateway: 'martian',
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: CLAUDE_SONNET_STEALTH_PRICING,
  exclusive_to: [],
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
  gateway: 'martian',
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: CLAUDE_OPUS_STEALTH_PRICING,
  exclusive_to: [],
  inference_provider_restriction: [],
};

export const claude_sonnet_clawsetup_model: KiloExclusiveModel = {
  public_id: CLAUDE_SONNET_CURRENT_MODEL_ID + ':clawsetup',
  internal_id: CLAUDE_SONNET_CURRENT_MODEL_ID,
  display_name: 'Claude Sonnet KiloClaw Setup Promo',
  description: 'Claude Sonnet KiloClaw Setup Promo',
  status: 'hidden', // only usable through kilo-auto
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  gateway: 'openrouter',
  flags: ['reasoning', 'vision'],
  pricing: null,
  exclusive_to: [],
  inference_provider_restriction: [],
};

export function isClaudeModel(requestedModel: string) {
  return requestedModel.includes('claude');
}

export function isHaikuModel(requestedModel: string) {
  return requestedModel.includes('haiku');
}

export function isOpusModel(requestedModel: string) {
  return requestedModel.includes('opus');
}
