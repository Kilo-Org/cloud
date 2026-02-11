/**
 * Utility functions for working with AI models
 */

import { KILO_AUTO_MODEL_ID } from '@/lib/kilo-auto-model';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  opus_46_free_slackbot_model,
} from '@/lib/providers/anthropic';
import { corethink_free_model } from '@/lib/providers/corethink';
import { giga_potato_model } from '@/lib/providers/gigapotato';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import {
  minimax_m21_free_model,
  minimax_m21_free_slackbot_model,
  minimax_m25_free_model,
} from '@/lib/providers/minimax';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';
import { zai_glm47_free_model, zai_glm5_free_model } from '@/lib/providers/zai';

export const DEFAULT_MODEL_CHOICES = [CLAUDE_SONNET_CURRENT_MODEL_ID, CLAUDE_OPUS_CURRENT_MODEL_ID];

export const PRIMARY_DEFAULT_MODEL = DEFAULT_MODEL_CHOICES[0];

export const preferredModels = [
  KILO_AUTO_MODEL_ID,
  minimax_m25_free_model.is_enabled ? minimax_m25_free_model.public_id : 'minimax/minimax-m2.5',
  zai_glm5_free_model.is_enabled ? zai_glm5_free_model.public_id : 'z-ai/glm-5',
  giga_potato_model.public_id,
  'arcee-ai/trinity-large-preview:free',
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.2',
  'openai/gpt-5.2-codex',
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'moonshotai/kimi-k2.5',
  grok_code_fast_1_optimized_free_model.is_enabled
    ? grok_code_fast_1_optimized_free_model.public_id
    : 'x-ai/grok-code-fast-1',
];

export function getFirstFreeModel() {
  return preferredModels.find(m => isFreeModel(m)) ?? PRIMARY_DEFAULT_MODEL;
}

const freeOpenRouterModels = [
  'openrouter/aurora-alpha',
  'openrouter/pony-alpha',
  'openrouter/free',
];

export function isFreeModel(model: string): boolean {
  return (
    kiloFreeModels.some(m => m.public_id === model && m.is_enabled) ||
    (model ?? '').endsWith(':free') ||
    freeOpenRouterModels.includes(model)
  );
}

export function isDataCollectionRequiredOnKiloCodeOnly(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled);
}

export const kiloFreeModels = [
  corethink_free_model,
  giga_potato_model,
  minimax_m21_free_model,
  minimax_m25_free_model,
  minimax_m21_free_slackbot_model,
  opus_46_free_slackbot_model,
  grok_code_fast_1_optimized_free_model,
  zai_glm47_free_model,
  zai_glm5_free_model,
] as KiloFreeModel[];

export function isStealthModelOnKiloCodeOnly(model: string): boolean {
  return kiloFreeModels.some(
    m => m.public_id === model && m.inference_providers.includes('stealth')
  );
}

export function extraRequiredProviders(model: string) {
  return kiloFreeModels.find(m => m.public_id === model)?.inference_providers ?? null;
}

export function isDeadFreeModel(model: string): boolean {
  return !!kiloFreeModels.find(m => m.public_id === model && !m.is_enabled);
}

/**
 * Check if a model is only available through Kilo for Slack (internalApiUse).
 * These models are hidden from the public model list and return "model does not exist"
 * when accessed outside of the Slack integration.
 */
export function isSlackbotOnlyModel(model: string): boolean {
  return !!kiloFreeModels.find(m => m.public_id === model && m.slackbot_only);
}
