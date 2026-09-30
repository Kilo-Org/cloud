/**
 * Utility functions for working with AI models
 */

import { KILO_AUTO_EFFICIENT_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import type { CurrentModelIds } from '@/lib/ai-gateway/current-models';
import { DEEPSEEK_V4_1_FLASH_MODEL_ID } from '@/lib/ai-gateway/providers/deepseek';
import { isMuseModel } from '@/lib/ai-gateway/providers/meta';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { isGrokModel } from '@/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import type { OpenRouterReasoningConfig } from '@/lib/ai-gateway/providers/openrouter/types';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';

export function getPrimaryDefaultModel(currentModelIds: CurrentModelIds): string {
  return currentModelIds.glmFlash;
}

export type AutoFreeModel = {
  model: string;
  weight: number;
  reasoning: OpenRouterReasoningConfig;
};

export const autoFreeModels: ReadonlyArray<AutoFreeModel> = [
  {
    model: 'stealth/space-bunny-alpha',
    weight: 7,
    reasoning: { enabled: true, effort: 'high' },
  } satisfies AutoFreeModel,
  {
    model: 'poolside/laguna-s-2.1:free',
    weight: 1,
    reasoning: { enabled: true, effort: 'high' },
  } satisfies AutoFreeModel,
  {
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    weight: 1,
    reasoning: { enabled: true, effort: 'high' },
  } satisfies AutoFreeModel,
  {
    model: 'dots-studio/dots-3-note-preview:free',
    weight: 1,
    reasoning: { enabled: true, effort: 'high' },
  } satisfies AutoFreeModel,
];

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

export function getPreferredModels(currentModelIds: CurrentModelIds): string[] {
  return [
    KILO_AUTO_EFFICIENT_MODEL.id,
    KILO_AUTO_FREE_MODEL.id,

    ...autoFreeModels.map(({ model }) => model),

    currentModelIds.claudeOpus,
    currentModelIds.gptSol,
    DEEPSEEK_V4_1_FLASH_MODEL_ID,
    currentModelIds.glmFlash,
    currentModelIds.kimi,
    MINIMAX_CURRENT_MODEL_ID,
  ];
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
