/**
 * Utility functions for working with AI models
 */

import { KILO_AUTO_MODEL_ID } from '@/lib/kilo-auto-model';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  opus_46_free_slackbot_model,
  sonnet_46_free_review_model,
} from '@/lib/providers/anthropic';
import { corethink_free_model } from '@/lib/providers/corethink';
import { giga_potato_model } from '@/lib/providers/gigapotato';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import { minimax_m21_free_model, minimax_m25_free_model } from '@/lib/providers/minimax';
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

export function isFreeModel(model: string): boolean {
  return (
    kiloFreeModels.some(m => m.public_id === model && m.is_enabled) ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    isOpenRouterStealthModel(model ?? '')
  );
}

export function isRateLimitedModel(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled && !m.allowed_uses?.length);
}

export function isDataCollectionRequiredOnKiloCodeOnly(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled);
}

export const kiloFreeModels = [
  corethink_free_model,
  giga_potato_model,
  minimax_m21_free_model,
  minimax_m25_free_model,
  opus_46_free_slackbot_model,
  sonnet_46_free_review_model,
  grok_code_fast_1_optimized_free_model,
  zai_glm47_free_model,
  zai_glm5_free_model,
] as KiloFreeModel[];

export function isKiloStealthModel(model: string): boolean {
  return kiloFreeModels.some(
    m => m.public_id === model && m.inference_providers.includes('stealth')
  );
}

function isOpenRouterStealthModel(model: string): boolean {
  return model.startsWith('openrouter/') && (model.endsWith('-alpha') || model.endsWith('-beta'));
}

export function extraRequiredProviders(model: string) {
  return kiloFreeModels.find(m => m.public_id === model)?.inference_providers ?? [];
}

export function isDeadFreeModel(model: string): boolean {
  return !!kiloFreeModels.find(m => m.public_id === model && !m.is_enabled);
}

/** Returns the first enabled review-use free model, or null. */
export function getActiveReviewFreeModel(): KiloFreeModel | null {
  return kiloFreeModels.find(m => m.allowed_uses?.includes('review') && m.is_enabled) ?? null;
}
