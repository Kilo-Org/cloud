import type { KiloExclusiveModel } from '@/lib/providers/kilo-exclusive-model';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.6';

export const CLAUDE_SONNET_CURRENT_MODEL_NAME = 'Claude Sonnet 4.6';

export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.6';

export const CLAUDE_OPUS_CURRENT_MODEL_NAME = 'Claude Opus 4.6';

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
  inference_provider: null,
  pricing: null,
};
