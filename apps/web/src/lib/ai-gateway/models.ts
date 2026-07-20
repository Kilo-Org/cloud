/**
 * Utility functions for working with AI models
 */

import {
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/ai-gateway/auto-model';
import {
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  claude_sonnet_clawsetup_model,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { seed_20_code_free_model } from '@/lib/ai-gateway/providers/seed';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { gemma_4_26b_a4b_it_free_model, isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { QWEN37_PLUS_MODEL_ID, qwen36_plus_stealth_model } from '@/lib/ai-gateway/providers/qwen';
import { stepfun_37_flash_free_model } from '@/lib/ai-gateway/providers/stepfun';
import { isGrokModel } from '@/lib/ai-gateway/providers/xai';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID, isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { gpt_5_6_sol_stealth_model } from '@/lib/ai-gateway/providers/openai-exclusive';
import { kat_coder_pro_v2_5_free_model } from '@/lib/ai-gateway/providers/streamlake';
import { GLM_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';
import {
  deepseek_v4_pro_discounted_model,
  deepseekDiscountedModels,
} from '@/lib/ai-gateway/providers/deepseek';
import { type ProviderId } from '@/lib/ai-gateway/providers/types';

export const PRIMARY_DEFAULT_MODEL = CLAUDE_SONNET_CURRENT_MODEL_ID;

export const autoFreeModels = [
  stepfun_37_flash_free_model.status === 'public' ? stepfun_37_flash_free_model.public_id : null,
].filter(m => m !== null);

export const preferredModels = [
  KILO_AUTO_FRONTIER_MODEL.id,
  KILO_AUTO_BALANCED_MODEL.id,
  KILO_AUTO_EFFICIENT_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,

  ...autoFreeModels,

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
  return isClaudeModel(model) || isOpenAiModel(model) || isGrokModel(model) || isGeminiModel(model);
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
  seed_20_code_free_model,
  kat_coder_pro_v2_5_free_model,
  ...deepseekDiscountedModels,
  qwen36_plus_stealth_model,
  gpt_5_6_sol_stealth_model,
  claude_sonnet_clawsetup_model,
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  stepfun_37_flash_free_model,
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

export function shouldRedactModelNameInResponse(provider: ProviderId, model: string): boolean {
  // custom is only used internally so we don't have to risk the perf or reliablity impact of rewriting the response
  return (
    provider !== 'martian' && // this is a stealth provider, but the models aren't stealth, so we can keep the model name in place
    (provider === 'experiment' || isKiloStealthModel(model))
  );
}

export function isDeadFreeModel(model: string): boolean {
  return !!kiloExclusiveModels.find(
    m => m.public_id === model && m.status === 'disabled' && !m.pricing
  );
}

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model && m.status !== 'disabled') ?? null;
}
