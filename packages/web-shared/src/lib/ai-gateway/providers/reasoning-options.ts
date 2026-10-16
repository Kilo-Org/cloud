import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { isDeepseekModel } from '@kilocode/web-shared/lib/ai-gateway/providers/deepseek';
import { isGeminiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { isMuseModel } from '@kilocode/web-shared/lib/ai-gateway/providers/meta';
import { isMinimaxModel } from '@kilocode/web-shared/lib/ai-gateway/providers/minimax';
import { isMistralModel } from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';
import { isKimiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/moonshotai';
import { isLongCatModel } from '@kilocode/web-shared/lib/ai-gateway/providers/longcat';
import { isOpenAiModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openai';
import { isQwenModel } from '@kilocode/web-shared/lib/ai-gateway/providers/qwen';
import { isStepModel } from '@kilocode/web-shared/lib/ai-gateway/providers/stepfun';
import { isGrokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/xai';
import { isGlmModel } from '@kilocode/web-shared/lib/ai-gateway/providers/zai';
import type { ReasoningEffort, ReasoningOption } from '@kilocode/db/schema-types';

export function effortOptions(...values: ReasoningEffort[]): ReasoningOption[] {
  return [{ type: 'effort', values }];
}

export const REASONING_TOGGLE: ReasoningOption[] = [{ type: 'toggle' }];

export function getFallbackReasoningOptions(model: string): ReasoningOption[] | undefined {
  if (isClaudeModel(model)) {
    return effortOptions('none', 'low', 'medium', 'high', 'xhigh', 'max');
  }
  if (isDeepseekModel(model)) {
    return effortOptions('none', 'low', 'high', 'max');
  }
  if (model.includes('gemma')) {
    return REASONING_TOGGLE;
  }
  if (isGeminiModel(model)) {
    return effortOptions('minimal', 'low', 'medium', 'high');
  }
  if (isGlmModel(model)) {
    return effortOptions('none', 'high', 'xhigh');
  }
  if (isGrokModel(model)) {
    return effortOptions('low', 'medium', 'high');
  }
  if (isKimiModel(model)) {
    return effortOptions('low', 'high', 'max');
  }
  if (isLongCatModel(model) || model.includes('laguna') || model.includes('ling-')) {
    return REASONING_TOGGLE;
  }
  if (model.includes('mercury')) {
    return effortOptions('none', 'low', 'medium', 'high');
  }
  if (isMinimaxModel(model) || model.includes('mimo') || isMistralModel(model)) {
    return REASONING_TOGGLE;
  }
  if (isMuseModel(model)) {
    return effortOptions('none', 'minimal', 'low', 'medium', 'high', 'xhigh');
  }
  if (model.includes('nemotron')) {
    return effortOptions('none', 'medium', 'high');
  }
  if (isOpenAiModel(model)) {
    return effortOptions('none', 'low', 'medium', 'high', 'xhigh', 'max');
  }
  if (isQwenModel(model)) {
    return effortOptions('minimal', 'low', 'medium', 'high', 'xhigh');
  }
  if (isStepModel(model)) {
    return effortOptions('low', 'medium', 'high');
  }
  if (model === 'stealth/glyph-cluster') {
    return effortOptions('low', 'medium', 'high', 'xhigh');
  }
  return undefined;
}
