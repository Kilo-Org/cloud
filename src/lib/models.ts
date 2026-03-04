/**
 * Utility functions for working with AI models
 */

import { KILO_AUTO_FREE_MODEL, KILO_AUTO_FRONTIER_MODEL } from '@/lib/kilo-auto-model';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/providers/anthropic';
import { corethink_free_model } from '@/lib/providers/corethink';
import { giga_potato_model, giga_potato_thinking_model } from '@/lib/providers/gigapotato';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import { minimax_m21_free_model, minimax_m25_free_model } from '@/lib/providers/minimax';
import { kimi_k25_free_model } from '@/lib/providers/moonshotai';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';
import { zai_glm5_free_model } from '@/lib/providers/zai';

export const DEFAULT_MODEL_CHOICES = [CLAUDE_SONNET_CURRENT_MODEL_ID, CLAUDE_OPUS_CURRENT_MODEL_ID];

export const PRIMARY_DEFAULT_MODEL = DEFAULT_MODEL_CHOICES[0];

export const preferredModels = [
  KILO_AUTO_FRONTIER_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,
  minimax_m25_free_model.is_enabled ? minimax_m25_free_model.public_id : 'minimax/minimax-m2.5',
  kimi_k25_free_model.is_enabled ? kimi_k25_free_model.public_id : 'moonshotai/kimi-k2.5',
  giga_potato_thinking_model.is_enabled ? giga_potato_thinking_model.public_id : null,
  'arcee-ai/trinity-large-preview:free',
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  'openai/gpt-5.2',
  'openai/gpt-5.3-codex',
  'google/gemini-3.1-pro-preview',
  'z-ai/glm-5',
  'x-ai/grok-code-fast-1',
].filter(m => m !== null);

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

export function isKiloFreeModel(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled);
}

export function isDataCollectionRequiredOnKiloCodeOnly(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.is_enabled);
}

export const kiloFreeModels = [
  // Please do not remove models from this list immediately.
  // Instead, set is_enabled to false first
  // and only remove when very few users are requesting it.
  corethink_free_model,
  giga_potato_model,
  giga_potato_thinking_model,
  kimi_k25_free_model,
  minimax_m25_free_model,
  minimax_m21_free_model,
  grok_code_fast_1_optimized_free_model,
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
