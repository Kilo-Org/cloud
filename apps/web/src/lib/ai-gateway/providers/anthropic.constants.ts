import type {
  KiloExclusiveModel,
  Pricing,
  Usage,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.7';
export const CLAUDE_HAIKU_CURRENT_MODEL_ID = 'anthropic/claude-haiku-4.5';

export const CLAUDE_OPUS_4_7_OPTIMIZED_MODEL_ID = 'anthropic/claude-opus-4-7:optimized';

export const CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID = CLAUDE_SONNET_CURRENT_MODEL_ID;
export const CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID = CLAUDE_OPUS_CURRENT_MODEL_ID;
export const CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID = CLAUDE_HAIKU_CURRENT_MODEL_ID;

// Anthropic list price for Claude Opus 4.7, minus 20% Kilo discount.
const OPUS_4_7_OPTIMIZED_PRICING: Pricing = {
  prompt_per_million: 4, // $5 list * 0.8
  completion_per_million: 20, // $25 list * 0.8
  input_cache_read_per_million: 0.4, // $0.50 list * 0.8
  input_cache_write_per_million: 5, // $6.25 list * 0.8
  calculate_mUsd: (usage: Usage) =>
    usage.uncachedInputTokens * 4 +
    usage.totalOutputTokens * 20 +
    usage.cacheHitTokens * 0.4 +
    usage.cacheWriteTokens * 5,
};

export const claude_opus_4_7_optimized_model: KiloExclusiveModel = {
  public_id: CLAUDE_OPUS_4_7_OPTIMIZED_MODEL_ID,
  internal_id: CLAUDE_OPUS_4_7_OPTIMIZED_MODEL_ID,
  display_name: 'Claude Opus 4.7 Optimized',
  description:
    'A custom-optimized variant of Claude Opus 4.7, exclusively available on Kilo Code and hosted by a stealth inference partner. **Note:** This is a third-party optimized model and your prompts and completions may be used to train or improve the provider\'s services.',
  context_length: 200_000,
  max_completion_tokens: 32_000,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'martian',
  pricing: OPUS_4_7_OPTIMIZED_PRICING,
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
