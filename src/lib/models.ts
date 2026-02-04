/**
 * Utility functions for working with AI models
 */

import { arcee_trinity_large_preview_free_model } from '@/lib/providers/arcee';
import { minimax_m21_free_model, minimax_m21_free_slackbot_model } from '@/lib/providers/minimax';
import { giga_potato_model } from '@/lib/providers/gigapotato';
import { devstral_small_2512_free_model } from '@/lib/providers/mistral';
import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import { kat_coder_pro_free_model } from '@/lib/providers/streamlake';
import { recommendedModels } from '@/lib/providers/recommended-models';
import { corethink_free_model } from '@/lib/providers/corethink';
import { zai_glm47_free_model } from '@/lib/providers/zai';

export const DEFAULT_MODEL_CHOICES = ['anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.5'];

export const PRIMARY_DEFAULT_MODEL = DEFAULT_MODEL_CHOICES[0];

export function getFirstFreeModel() {
  return recommendedModels.find(m => isFreeModel(m.public_id))?.public_id ?? PRIMARY_DEFAULT_MODEL;
}

export const preferredModels = recommendedModels.map(m => m.public_id);

export function isFreeModel(model: string): boolean {
  return !!kiloFreeModels.find(m => m.public_id === model && m.is_enabled);
}

export function isDataCollectionRequiredOnKiloCodeOnly(model: string): boolean {
  return isFreeModel(model);
}

export const kiloFreeModels = [
  arcee_trinity_large_preview_free_model,
  devstral_small_2512_free_model,
  giga_potato_model,
  kat_coder_pro_free_model,
  minimax_m21_free_model,
  corethink_free_model,
  minimax_m21_free_slackbot_model,
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
