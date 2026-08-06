/**
 * Utility functions for working with AI models
 */

import { KILO_AUTO_EFFICIENT_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import {
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { isMuseModel } from '@/lib/ai-gateway/providers/meta';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { gemma_4_26b_a4b_it_free_model, isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { QWEN37_PLUS_MODEL_ID, qwen36_plus_stealth_model } from '@/lib/ai-gateway/providers/qwen';
import { stepfun_37_flash_free_model } from '@/lib/ai-gateway/providers/stepfun';
import { tencent_hy3_free_model } from '@/lib/ai-gateway/providers/tencent';
import { isGrokModel } from '@/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID, isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { gpt_5_6_sol_stealth_model } from '@/lib/ai-gateway/providers/openai-exclusive';
import { GLM_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';
import {
  deepseek_v4_pro_discounted_model,
  deepseekDiscountedModels,
} from '@/lib/ai-gateway/providers/deepseek';
import { type ProviderId } from '@/lib/ai-gateway/providers/types';
import type { OpenRouterReasoningConfig } from '@/lib/ai-gateway/providers/openrouter/types';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';

export const PRIMARY_DEFAULT_MODEL = CLAUDE_SONNET_CURRENT_MODEL_ID;

export type AutoFreeModel = {
  model: string;
  weight: number;
  reasoning: OpenRouterReasoningConfig;
};

export const autoFreeModels: ReadonlyArray<AutoFreeModel> = [
  ...(stepfun_37_flash_free_model.status === 'public'
    ? [
        {
          model: stepfun_37_flash_free_model.public_id,
          weight: 3,
          reasoning: { enabled: true, effort: 'high' },
        } satisfies AutoFreeModel,
      ]
    : []),
  {
    model: 'inclusionai/ling-3.0-flash:free',
    weight: 3,
    reasoning: { enabled: true, effort: 'high' },
  } satisfies AutoFreeModel,
  {
    model: 'poolside/laguna-s-2.1:free',
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
  ...(tencent_hy3_free_model.status === 'public' ? [tencent_hy3_free_model.public_id] : []),

  CLAUDE_SONNET_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  GPT_CURRENT_MODEL_ID,
  ...(gpt_5_6_sol_stealth_model.status === 'public' ? [gpt_5_6_sol_stealth_model.public_id] : []),
  deepseek_v4_pro_discounted_model.status === 'public'
    ? deepseek_v4_pro_discounted_model.public_id
    : 'deepseek/deepseek-v4-pro',
  GLM_CURRENT_MODEL_ID,
  KIMI_CURRENT_MODEL_ID,
  MINIMAX_CURRENT_MODEL_ID,
  QWEN37_PLUS_MODEL_ID,
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

export function isKiloExclusiveFreeModel(model: string): boolean {
  return kiloExclusiveModels.some(
    m => m.public_id === model && m.status !== 'disabled' && !m.pricing
  );
}

export function isKiloExclusiveModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.status !== 'disabled');
}

export function isKiloExclusiveRateLimitedModel(model: string): boolean {
  return kiloExclusiveModels.some(
    m => m.public_id === model && m.status !== 'disabled' && m.flags.includes('rate-limited')
  );
}

export const kiloExclusiveModels = [
  gemma_4_26b_a4b_it_free_model,
  ...deepseekDiscountedModels,
  qwen36_plus_stealth_model,
  gpt_5_6_sol_stealth_model,
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  stepfun_37_flash_free_model,
  tencent_hy3_free_model,
] as KiloExclusiveModel[];

export function isKiloStealthModel(model: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === model && m.flags.includes('stealth'));
}

export function shouldRedactModelNameInMicrodollarUsage(
  provider: ProviderId,
  model: string
): boolean {
  return provider === 'custom' || provider === 'experiment' || isKiloStealthModel(model);
}

export function shouldRedactErrorResponse(provider: ProviderId, model: string): boolean {
  return provider === 'custom' || provider === 'experiment' || isKiloStealthModel(model);
}

export function isDeadFreeModel(model: string): boolean {
  return !!kiloExclusiveModels.find(
    m => m.public_id === model && m.status === 'disabled' && !m.pricing
  );
}

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model && m.status !== 'disabled') ?? null;
}
