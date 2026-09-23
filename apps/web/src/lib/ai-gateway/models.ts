import { KILO_AUTO_EFFICIENT_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import { DEEPSEEK_V4_1_FLASH_MODEL_ID } from '@/lib/ai-gateway/providers/deepseek';
import { isMuseModel } from '@/lib/ai-gateway/providers/meta';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { isGrokModel } from '@/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_SOL_CURRENT_MODEL_ID, isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { GLM_FLASH_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';
import type { OpenRouterReasoningConfig } from '@/lib/ai-gateway/providers/openrouter/types';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';

export const PRIMARY_DEFAULT_MODEL = GLM_FLASH_CURRENT_MODEL_ID;

export type AutoFreeModel = {
  model: string;
  weight: number;
  reasoning: OpenRouterReasoningConfig;
};

export const autoFreeModels: ReadonlyArray<AutoFreeModel> = [
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
  {
    model: 'nex-agi/nex-n2.5-pro:free',
    weight: 1,
    reasoning: { enabled: true, effort: 'high' },
  } satisfies AutoFreeModel,
  {
    model: 'inclusionai/ling-3.0-flash-vl:free',
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

export const preferredModels = [
  KILO_AUTO_EFFICIENT_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,

  ...autoFreeModels.map(({ model }) => model),

  CLAUDE_OPUS_CURRENT_MODEL_ID,
  GPT_SOL_CURRENT_MODEL_ID,
  DEEPSEEK_V4_1_FLASH_MODEL_ID,
  GLM_FLASH_CURRENT_MODEL_ID,
  KIMI_CURRENT_MODEL_ID,
  MINIMAX_CURRENT_MODEL_ID,
];

export function isPdfSupportingModel(model: string): boolean {
  return (
    isClaudeModel(model) ||
    isOpenAiModel(model) ||
    isGrokModel(model) ||
    isGeminiModel(model) ||
    isMuseModel(model)
  );
}
