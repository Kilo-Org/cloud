/**
 * Utility functions for working with AI models
 */

import { opus_46_free_slackbot_model } from '@/lib/providers/anthropic';
import { corethink_free_model } from '@/lib/providers/corethink';
import { giga_potato_model } from '@/lib/providers/gigapotato';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import { minimax_m21_free_model, minimax_m21_free_slackbot_model } from '@/lib/providers/minimax';
import { recommendedModels } from '@/lib/providers/recommended-models';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';
import { zai_glm47_free_model } from '@/lib/providers/zai';

export const DEFAULT_MODEL_CHOICES = ['anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.6'];

export const PRIMARY_DEFAULT_MODEL = DEFAULT_MODEL_CHOICES[0];

export function getFirstFreeModel() {
  return recommendedModels.find(m => isFreeModel(m.public_id))?.public_id ?? PRIMARY_DEFAULT_MODEL;
}

export const preferredModels = recommendedModels.map(m => m.public_id);

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
  minimax_m21_free_slackbot_model,
  opus_46_free_slackbot_model,
  grok_code_fast_1_optimized_free_model,
  zai_glm47_free_model,
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
