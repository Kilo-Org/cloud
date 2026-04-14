import { z } from 'zod';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  claude_sonnet_clawsetup_model,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/providers/anthropic.constants';
import { minimax_m25_free_model } from '@/lib/providers/minimax';
import { qwen36_plus_model } from '@/lib/providers/qwen';
import type { OpenRouterReasoningConfig } from '@/lib/providers/openrouter/types';
import type { ModelSettings, OpenCodeSettings, Verbosity } from '@kilocode/db/schema-types';

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
  roocode_settings: ModelSettings | undefined;
  opencode_settings: OpenCodeSettings | undefined;
};

export type ResolvedAutoModel = {
  model: string;
  reasoning?: OpenRouterReasoningConfig;
  verbosity?: Verbosity;
};

export const GPT_53_CODEX_ID = 'openai/gpt-5.3-codex';

export const KILO_AUTO_LEGACY_MODEL = 'kilo/auto'; // hardcoded in upstream OpenClaw

export const modeSchema = z.enum([
  'KiloClaw',
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

export const FRONTIER_CODE_MODEL: ResolvedAutoModel = {
  model: CLAUDE_SONNET_CURRENT_MODEL_ID,
  reasoning: { enabled: true },
  verbosity: 'low',
};

export const FRONTIER_MODE_TO_MODEL: Record<Mode, ResolvedAutoModel> = {
  KiloClaw: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  plan: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  general: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'medium',
  },
  architect: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  orchestrator: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  ask: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  debug: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  build: {
    model: CLAUDE_SONNET_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'medium',
  },
  explore: {
    model: CLAUDE_SONNET_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'medium',
  },
  code: FRONTIER_CODE_MODEL,
};

export const BALANCED_CODEX_MODEL: ResolvedAutoModel = {
  model: GPT_53_CODEX_ID,
  reasoning: { enabled: true, effort: 'low' },
};

export const BALANCED_QWEN_MODEL: ResolvedAutoModel = {
  model: qwen36_plus_model.public_id,
  reasoning: { enabled: true },
};

export const BALANCED_CLAW_SETUP_MODEL: ResolvedAutoModel = {
  model: claude_sonnet_clawsetup_model.public_id,
  reasoning: { enabled: true, effort: 'high' },
  verbosity: 'high',
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
  roocode_settings: undefined,
  opencode_settings: {
    family: 'claude',
    prompt: 'anthropic',
  },
};

export const KILO_AUTO_FREE_MODEL: AutoModel = {
  id: 'kilo-auto/free',
  name: 'Kilo Auto Free',
  description: 'Free with limited capability. No credits required.',
  context_length: minimax_m25_free_model.context_length,
  max_completion_tokens: minimax_m25_free_model.max_completion_tokens,
  prompt_price: '0',
  completion_price: '0',
  input_cache_read_price: '0',
  input_cache_write_price: '0',
  supports_images: false,
  roocode_settings: {
    included_tools: ['search_and_replace'],
    excluded_tools: ['apply_diff', 'edit_file'],
  },
  opencode_settings: undefined,
};

export const KILO_AUTO_BALANCED_MODEL: AutoModel = {
  id: 'kilo-auto/balanced',
  name: 'Kilo Auto Balanced',
  description: 'Great balance of price and capability.',
  context_length: 400_000,
  max_completion_tokens: 65_536,
  prompt_price: '0.00000175',
  completion_price: '0.000014',
  input_cache_read_price: '0.000000175',
  input_cache_write_price: undefined,
  supports_images: true,
  roocode_settings: {
    included_tools: ['apply_patch'],
    excluded_tools: ['apply_diff', 'edit_file'],
  },
  opencode_settings: {
    ai_sdk_provider: 'openai',
    family: 'gpt',
    prompt: 'codex',
  },
};

export const KILO_AUTO_SMALL_MODEL: AutoModel = {
  id: 'kilo-auto/small',
  name: 'Kilo Auto Small',
  description: 'Automatically routes your request to a small model.',
  context_length: 131072,
  max_completion_tokens: 32768,
  prompt_price: '0.00000005',
  completion_price: '0.0000004',
  input_cache_read_price: '0.000000005',
  input_cache_write_price: undefined,
  supports_images: false,
  roocode_settings: undefined,
  opencode_settings: {
    ai_sdk_provider: 'openai',
  },
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
