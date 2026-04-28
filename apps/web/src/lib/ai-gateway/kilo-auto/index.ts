import { z } from 'zod';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  claude_sonnet_clawsetup_model,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import type { OpenRouterReasoningConfig } from '@/lib/ai-gateway/providers/openrouter/types';
import type { OpenCodeSettings, Verbosity } from '@kilocode/db/schema-types';
import { qwen36_plus_model } from '@/lib/ai-gateway/providers/qwen';

type AutoModel = {
  id: string;
  name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  prompt_price: string;
  completion_price: string;
  input_cache_read_price: string | undefined;
  input_cache_write_price: string | undefined;
  supports_images: boolean;
  supports_pdf: boolean;
  opencode_settings: OpenCodeSettings | undefined;
};

export type ResolvedAutoModel = {
  model: string;
  reasoning?: OpenRouterReasoningConfig;
  verbosity?: Verbosity;
};

export const KILO_AUTO_LEGACY_MODEL = 'kilo/auto'; // hardcoded in upstream OpenClaw

export const modeSchema = z.enum([
  'claw',
  'plan',
  'general',
  'architect',
  'orchestrator',
  'ask',
  'debug',
  'build',
  'explore',
  'code',
]);

type Mode = z.infer<typeof modeSchema>;

const FRONTIER_REASONING = { enabled: true, effort: 'medium' } as const;
const FRONTIER_VERBOSITY = 'medium' as const;

const OPUS_FRONTIER: ResolvedAutoModel = {
  model: CLAUDE_OPUS_CURRENT_MODEL_ID,
  reasoning: FRONTIER_REASONING,
  verbosity: FRONTIER_VERBOSITY,
};

const SONNET_FRONTIER: ResolvedAutoModel = {
  model: CLAUDE_SONNET_CURRENT_MODEL_ID,
  reasoning: FRONTIER_REASONING,
  verbosity: FRONTIER_VERBOSITY,
};

export const FRONTIER_CODE_MODEL: ResolvedAutoModel = SONNET_FRONTIER;

export const FRONTIER_MODE_TO_MODEL: Record<Mode, ResolvedAutoModel> = {
  claw: OPUS_FRONTIER,
  plan: OPUS_FRONTIER,
  general: OPUS_FRONTIER,
  architect: OPUS_FRONTIER,
  orchestrator: OPUS_FRONTIER,
  ask: OPUS_FRONTIER,
  debug: OPUS_FRONTIER,
  build: SONNET_FRONTIER,
  explore: SONNET_FRONTIER,
  code: SONNET_FRONTIER,
};

export const BALANCED_RESPONSES_FALLBACK_MODEL: ResolvedAutoModel = {
  model: 'openai/gpt-5.5',
  reasoning: { enabled: true, effort: 'low' },
};

export const BALANCED_MESSAGES_FALLBACK_MODEL: ResolvedAutoModel = {
  model: CLAUDE_SONNET_CURRENT_MODEL_ID,
  reasoning: { enabled: true, effort: 'low' },
};

export const BALANCED_CLAW_SETUP_MODEL: ResolvedAutoModel = {
  model: claude_sonnet_clawsetup_model.public_id,
  reasoning: { enabled: true, effort: 'high' },
  verbosity: 'high',
};

export const BALANCED_QWEN_MODEL: ResolvedAutoModel = {
  model: qwen36_plus_model.public_id,
  reasoning: { enabled: true },
};

export const KILO_AUTO_FRONTIER_MODEL: AutoModel = {
  id: 'kilo-auto/frontier',
  name: 'Kilo Auto Frontier',
  description: 'Highest performance and capability for any task.',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  prompt_price: '0.000005',
  completion_price: '0.000025',
  input_cache_read_price: '0.0000005',
  input_cache_write_price: '0.00000625',
  supports_images: true,
  supports_pdf: true,
  opencode_settings: {
    family: 'claude',
    prompt: 'anthropic',
  },
};

export const KILO_AUTO_FREE_MODEL: AutoModel = {
  id: 'kilo-auto/free',
  name: 'Kilo Auto Free',
  description:
    'Free with limited capability. No credits required. Note: prompts may be logged by the upstream provider and used to improve their services.',
  context_length: 256_000,
  max_completion_tokens: 10_000,
  prompt_price: '0',
  completion_price: '0',
  input_cache_read_price: '0',
  input_cache_write_price: '0',
  supports_images: false,
  supports_pdf: false,
  opencode_settings: undefined,
};

export const KILO_AUTO_BALANCED_MODEL: AutoModel = {
  id: 'kilo-auto/balanced',
  name: 'Kilo Auto Balanced',
  description: 'Great balance of price and capability.',
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  prompt_price: '0.000000325',
  completion_price: '0.00000195',
  input_cache_read_price: '0.0000000325',
  input_cache_write_price: '0.00000040625',
  supports_images: true,
  supports_pdf: false,
  opencode_settings: {
    ai_sdk_provider: 'alibaba',
  },
};

export const KILO_AUTO_SMALL_MODEL: AutoModel = {
  id: 'kilo-auto/small',
  name: 'Kilo Auto Small',
  description: 'Automatically routes your request to a small model.',
  context_length: 262144,
  max_completion_tokens: 32768,
  prompt_price: '0.00000005',
  completion_price: '0.0000004',
  input_cache_read_price: '0.000000005',
  input_cache_write_price: undefined,
  supports_images: true,
  supports_pdf: false,
  opencode_settings: undefined,
};

export const AUTO_MODELS = [
  KILO_AUTO_FRONTIER_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
];

export function isKiloAutoModel(model: string) {
  return AUTO_MODELS.some(m => m.id === model) || model === KILO_AUTO_LEGACY_MODEL;
}
