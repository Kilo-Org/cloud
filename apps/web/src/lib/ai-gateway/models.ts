/**
 * Utility functions for working with AI models
 */

import type { FeatureValue } from '@/lib/feature-detection';
import {
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/ai-gateway/kilo-auto';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  claude_sonnet_clawsetup_model,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { seed_20_code_free_model } from '@/lib/ai-gateway/providers/seed';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  MINIMAX_CURRENT_MODEL_ID,
  minimax_m25_free_model,
} from '@/lib/ai-gateway/providers/minimax';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { morph_warp_grep_free_model } from '@/lib/ai-gateway/providers/morph';
import {
  GEMINI_PRO_CURRENT_MODEL_ID,
  gemma_4_26b_a4b_it_free_model,
} from '@/lib/ai-gateway/providers/google';
import { alibabaDirectModels, qwen36_plus_model } from '@/lib/ai-gateway/providers/qwen';
import { stepfun_35_flash_free_model } from '@/lib/ai-gateway/providers/stepfun';
import {
  grok_code_fast_1_optimized_free_model,
  isGrok4Model,
} from '@/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID, isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { GLM_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';

export const PRIMARY_DEFAULT_MODEL = CLAUDE_SONNET_CURRENT_MODEL_ID;

export const autoFreeModels = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'poolside/laguna-m.1:free',
  grok_code_fast_1_optimized_free_model.status === 'public'
    ? grok_code_fast_1_optimized_free_model.public_id
    : null,
  stepfun_35_flash_free_model.status === 'public' ? stepfun_35_flash_free_model.public_id : null,
].filter(m => m !== null);

export const preferredModels = [
  KILO_AUTO_FRONTIER_MODEL.id,
  KILO_AUTO_BALANCED_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,
  ...autoFreeModels,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  KIMI_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  GPT_CURRENT_MODEL_ID,
  GEMINI_PRO_CURRENT_MODEL_ID,
  MINIMAX_CURRENT_MODEL_ID,
  qwen36_plus_model.public_id,
  GLM_CURRENT_MODEL_ID,
];

export function isFreeModel(model: string): boolean {
  return (
    isKiloExclusiveFreeModel(model) ||
    model === KILO_AUTO_FREE_MODEL.id ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    isOpenRouterStealthModel(model ?? '')
  );
}

export function isPdfSupportingModel(model: string): boolean {
  return isClaudeModel(model) || isOpenAiModel(model) || isGrok4Model(model);
}

export function isKiloExclusiveFreeModel(model: string): boolean {
  return kiloExclusiveModels.some(
    m => m.public_id === model && m.status !== 'disabled' && !m.pricing
  );
}

export function isKiloExclusiveModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.status !== 'disabled');
}

export const kiloExclusiveModels = [
  gemma_4_26b_a4b_it_free_model,
  minimax_m25_free_model,
  morph_warp_grep_free_model,
  grok_code_fast_1_optimized_free_model,
  seed_20_code_free_model,
  ...alibabaDirectModels,
  claude_sonnet_clawsetup_model,
  stepfun_35_flash_free_model,
] as KiloExclusiveModel[];

export function isKiloStealthModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.flags.includes('stealth'));
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
