/**
 * Utility functions for working with AI models
 */

import {
  isKiloAutoModel,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_FREE_MODEL_DEPRECATED,
  KILO_AUTO_FRONTIER_MODEL,
  resolveAutoModel,
} from '@/lib/kilo-auto-model';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/providers/anthropic';
import { corethink_free_model } from '@/lib/providers/corethink';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import {
  MINIMAX_CURRENT_MODEL_ID,
  minimax_m21_free_model,
  minimax_m25_free_model,
} from '@/lib/providers/minimax';
import { KIMI_CURRENT_MODEL_ID, kimi_k25_free_model } from '@/lib/providers/moonshotai';
import { morph_warp_grep_free_model } from '@/lib/providers/morph';
import { qwen35_plus_free_model } from '@/lib/providers/qwen';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';
import { mimo_v2_omni_free_model, mimo_v2_pro_free_model } from '@/lib/providers/xiaomi';
import { zai_glm5_free_model } from '@/lib/providers/zai';

export const PRIMARY_DEFAULT_MODEL = CLAUDE_SONNET_CURRENT_MODEL_ID;

export const preferredModels = [
  KILO_AUTO_FRONTIER_MODEL.id,
  KILO_AUTO_BALANCED_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,
  mimo_v2_pro_free_model.status === 'public' ? mimo_v2_pro_free_model.public_id : null,
  'nvidia/nemotron-3-super-120b-a12b:free',
  'arcee-ai/trinity-large-preview:free',
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  'openai/gpt-5.4',
  'google/gemini-3.1-pro-preview',
  MINIMAX_CURRENT_MODEL_ID,
  KIMI_CURRENT_MODEL_ID,
  'z-ai/glm-5',
  'x-ai/grok-code-fast-1',
].filter(m => m !== null);

export function getMonitoredModels() {
  return [
    ...new Set(
      preferredModels.map(model =>
        isKiloAutoModel(model) ? resolveAutoModel(model, null).model : model
      )
    ),
  ];
}

export function isFreeModel(model: string): boolean {
  return (
    isKiloFreeModel(model) ||
    model === KILO_AUTO_FREE_MODEL.id ||
    model === KILO_AUTO_FREE_MODEL_DEPRECATED ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    isOpenRouterStealthModel(model ?? '')
  );
}

export function isKiloFreeModel(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.status !== 'disabled');
}

export function isDataCollectionRequiredOnKiloCodeOnly(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.status !== 'disabled');
}

export const kiloFreeModels = [
  // Please do not remove models from this list immediately.
  // Instead, set status to 'disabled' first
  // and only remove when very few users are requesting it.
  corethink_free_model,
  kimi_k25_free_model,
  minimax_m25_free_model,
  minimax_m21_free_model,
  mimo_v2_pro_free_model,
  mimo_v2_omni_free_model,
  morph_warp_grep_free_model,
  grok_code_fast_1_optimized_free_model,
  qwen35_plus_free_model,
  zai_glm5_free_model,
] as KiloFreeModel[];

export function isKiloStealthModel(model: string): boolean {
  return kiloFreeModels.some(m => m.public_id === model && m.inference_provider === 'stealth');
}

function isOpenRouterStealthModel(model: string): boolean {
  return model.startsWith('openrouter/') && (model.endsWith('-alpha') || model.endsWith('-beta'));
}

export function isDeadFreeModel(model: string): boolean {
  return !!kiloFreeModels.find(m => m.public_id === model && m.status === 'disabled');
}
