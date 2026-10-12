/**
 * Utility functions for working with AI models
 */

import {
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { DEEPSEEK_V4_1_FLASH_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/deepseek';
import { isMuseModel } from '@kilocode/web-shared/lib/ai-gateway/providers/meta';
import { KIMI_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/moonshotai';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { isGrokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import {
  GPT_SOL_CURRENT_MODEL_ID,
  isOpenAiModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openai';
import { GLM_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/zai';
import { STEP_5_PREVIEW_FREE_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/stepfun';
import type { AutoFreeModelConfig } from '@kilocode/db/schema-types';
import { getRandomNumber } from '@kilocode/web-shared/lib/ai-gateway/getRandomNumber';

export const PRIMARY_DEFAULT_MODEL = GLM_FLASH_CURRENT_MODEL_ID;

export type AutoFreeModel = AutoFreeModelConfig;

export function selectAutoFreeCandidate(
  candidates: ReadonlyArray<AutoFreeModel>,
  randomSeed: string
): AutoFreeModel | null {
  const totalWeight = candidates.reduce((total, candidate) => total + candidate.weight, 0);
  if (totalWeight === 0) return null;

  const bucket = getRandomNumber(randomSeed, totalWeight);
  let cumulativeWeight = 0;
  for (const candidate of candidates) {
    cumulativeWeight += candidate.weight;
    if (bucket < cumulativeWeight) return candidate;
  }
  return null;
}

const GLYPH_CLUSTER_STEALTH_MODEL_ID = 'stealth/glyph-cluster';

const PREFERRED_CONCRETE_MODELS: ReadonlyArray<string> = [
  STEP_5_PREVIEW_FREE_MODEL_ID,
  GLYPH_CLUSTER_STEALTH_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  GPT_SOL_CURRENT_MODEL_ID,
  DEEPSEEK_V4_1_FLASH_MODEL_ID,
  GLM_FLASH_CURRENT_MODEL_ID,
  KIMI_CURRENT_MODEL_ID,
];

export const PREFERRED_MODELS: ReadonlyArray<string> = [
  KILO_AUTO_EFFICIENT_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,
  ...PREFERRED_CONCRETE_MODELS,
];

/**
 * The concrete preferred models plus the models kilo-auto/free routes to; auto models route
 * elsewhere and are not monitored. The auto-free models come from the admin auto-free
 * configuration, which only the server can read; use `getMonitoredModels` on the server.
 */
export function buildMonitoredModels(autoFreeModels: ReadonlyArray<string>): string[] {
  return [...new Set([...PREFERRED_CONCRETE_MODELS, ...autoFreeModels])];
}

export function isPdfSupportingModel(model: string): boolean {
  return (
    isClaudeModel(model) ||
    isOpenAiModel(model) ||
    isGrokModel(model) ||
    isGeminiModel(model) ||
    isMuseModel(model)
  );
}
