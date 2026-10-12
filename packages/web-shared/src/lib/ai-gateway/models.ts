/**
 * Utility functions for working with AI models
 */

import { isMuseModel } from '@kilocode/web-shared/lib/ai-gateway/providers/meta';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { isGrokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { isOpenAiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openai';
import { GLM_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/zai';
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

export function isPdfSupportingModel(model: string): boolean {
  return (
    isClaudeModel(model) ||
    isOpenAiModel(model) ||
    isGrokModel(model) ||
    isGeminiModel(model) ||
    isMuseModel(model)
  );
}
