/**
 * Utility functions for working with AI models
 */

import type { FeatureValue } from '@/lib/feature-detection';
import {
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/kilo-auto';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  claude_sonnet_clawsetup_model,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/providers/anthropic.constants';
import { trinity_large_thinking_free_model } from '@/lib/providers/arcee';
import { seed_20_pro_free_model } from '@/lib/providers/bytedance';
import type { KiloExclusiveModel } from '@/lib/providers/kilo-exclusive-model';
import { MINIMAX_CURRENT_MODEL_ID, minimax_m25_free_model } from '@/lib/providers/minimax';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/providers/moonshotai';
import { morph_warp_grep_free_model } from '@/lib/providers/morph';
import { gpt_oss_20b_free_model } from '@/lib/providers/openai';
import { qwen36_plus_model } from '@/lib/providers/qwen';
import { stepfun_35_flash_free_model } from '@/lib/providers/stepfun';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';

export const PRIMARY_DEFAULT_MODEL = CLAUDE_SONNET_CURRENT_MODEL_ID;

export const preferredModels = [
  KILO_AUTO_FRONTIER_MODEL.id,
  KILO_AUTO_BALANCED_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,
  seed_20_pro_free_model.status === 'public' ? seed_20_pro_free_model.public_id : null,
  grok_code_fast_1_optimized_free_model.status === 'public'
    ? grok_code_fast_1_optimized_free_model.public_id
    : null,
  stepfun_35_flash_free_model.status === 'public' ? stepfun_35_flash_free_model.public_id : null,
  'openrouter/elephant-alpha',
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  'openai/gpt-5.4',
  'google/gemini-3.1-pro-preview',
  MINIMAX_CURRENT_MODEL_ID,
  KIMI_CURRENT_MODEL_ID,
  'z-ai/glm-5.1',
].filter(m => m !== null);

export function isFreeModel(model: string): boolean {
  return (
    isKiloExclusiveFreeModel(model) ||
    model === KILO_AUTO_FREE_MODEL.id ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    isOpenRouterStealthModel(model ?? '')
  );
}

export function isKiloExclusiveFreeModel(model: string): boolean {
  return kiloExclusiveModels.some(
    m => m.public_id === model && m.status !== 'disabled' && !m.pricing
  );
}

export const kiloExclusiveModels = [
  // Please do not remove models from this list immediately.
  // Instead, set status to 'disabled' first
  // and only remove when very few users are requesting it.
  gpt_oss_20b_free_model,
  minimax_m25_free_model,
  morph_warp_grep_free_model,
  grok_code_fast_1_optimized_free_model,
  seed_20_pro_free_model,
  qwen36_plus_model,
  trinity_large_thinking_free_model,
  claude_sonnet_clawsetup_model,
  stepfun_35_flash_free_model,
] as KiloExclusiveModel[];

export function isKiloStealthModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.inference_provider === 'stealth');
}

function isOpenRouterStealthModel(model: string): boolean {
  return model.startsWith('openrouter/') && (model.endsWith('-alpha') || model.endsWith('-beta'));
}

export function isDeadFreeModel(model: string): boolean {
  return !!kiloExclusiveModels.find(
    m => m.public_id === model && m.status === 'disabled' && !m.pricing
  );
}

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model && m.status !== 'disabled') ?? null;
}

/**
 * Returns true if the model should be excluded for the given feature.
 * A model is excluded when its `exclusive_to` list is non-empty, the feature is known,
 * and the feature is not in `exclusive_to`.
 * When feature is null (no header sent), the model is always included.
 */
export function isExcludedForFeature(modelId: string, feature: FeatureValue | null): boolean {
  const model = kiloExclusiveModels.find(m => m.public_id === modelId);
  if (!model?.exclusive_to.length) return false;
  if (!feature) return false;
  return !model.exclusive_to.includes(feature);
}

/** Filters out models that are not available for the given feature. */
export function filterByFeature<T extends { id: string }>(
  models: T[],
  feature: FeatureValue | null
): T[] {
  return models.filter(m => !isExcludedForFeature(m.id, feature));
}
