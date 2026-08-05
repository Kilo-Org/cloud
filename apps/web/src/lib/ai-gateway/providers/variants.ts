import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import { isGemini3Model, isGemmaModel } from '@/lib/ai-gateway/providers/google';
import { isMuseModel } from '@/lib/ai-gateway/providers/meta';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import { isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { isQwenModel } from '@/lib/ai-gateway/providers/qwen';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isGrok42Model, isGrok45Model } from '@/lib/ai-gateway/providers/xai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { type OpenCodeSettings, ReasoningEffortSchema } from '@kilocode/db/schema-types';

export const REASONING_VARIANTS_THINKING_ONLY = {
  thinking: { reasoning: { enabled: true, effort: 'high' } },
} as const;

export const REASONING_VARIANTS_BINARY = {
  instant: { reasoning: { enabled: false, effort: 'none' } },
  ...REASONING_VARIANTS_THINKING_ONLY,
} as const;

export const REASONING_VARIANTS_LOW_MEDIUM_HIGH = {
  low: { reasoning: { enabled: true, effort: 'low' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
} as const;

export const REASONING_VARIANTS_MAX_HIGH_LOW = {
  max: { reasoning: { enabled: true, effort: 'max' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
} as const;

export const REASONING_VARIANTS_XHIGH_MEDIUM_LOW = {
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
} as const;

export const REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH = {
  minimal: { reasoning: { enabled: true, effort: 'minimal' } },
  ...REASONING_VARIANTS_LOW_MEDIUM_HIGH,
} as const;

export const REASONING_VARIANTS_NONE_MINIMAL_LOW_MEDIUM_HIGH = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  ...REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
} as const;

export const REASONING_VARIANTS_NONE_HIGH_XHIGH = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
} as const;

const REASONING_VARIANTS_CLAUDE = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
  medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
  high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
  max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
} as const;

export const REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH = {
  instant: REASONING_VARIANTS_BINARY.instant,
  ...REASONING_VARIANTS_LOW_MEDIUM_HIGH,
} as const;

export function getFallbackModelVariants(model: string): OpenCodeSettings['variants'] {
  if (isClaudeModel(model)) {
    return REASONING_VARIANTS_CLAUDE;
  }
  if (model.includes('codex') || isGemini3Model(model)) {
    return Object.fromEntries(
      ReasoningEffortSchema.options
        .filter(e => e !== 'none' && e !== 'minimal' && e !== 'max')
        .map(effort => [effort, { reasoning: { enabled: true, effort } }])
    );
  }
  if (isOpenAiModel(model)) {
    return Object.fromEntries(
      ReasoningEffortSchema.options
        .filter(e => e !== 'minimal')
        .map(effort => [effort, { reasoning: { enabled: effort !== 'none', effort } }])
    );
  }
  if (model.includes('mistral-medium-3-5')) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model.includes('kimi-k2.7-code')) {
    return REASONING_VARIANTS_THINKING_ONLY;
  }
  if (model.includes('kimi-k2')) {
    return REASONING_VARIANTS_BINARY;
  }
  if (isKimiModel(model)) {
    return REASONING_VARIANTS_MAX_HIGH_LOW;
  }
  if (model.includes('qwen3.8') && (model.includes('plus') || model.includes('max'))) {
    return REASONING_VARIANTS_XHIGH_MEDIUM_LOW;
  }
  if (
    isMinimaxModel(model) ||
    isGrok42Model(model) ||
    isQwenModel(model) ||
    isGemmaModel(model) ||
    model.includes('mimo')
  ) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model.startsWith('inception/mercury-2')) {
    return REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH;
  }
  if (isStepModel(model) || isGrok45Model(model)) {
    return REASONING_VARIANTS_LOW_MEDIUM_HIGH;
  }
  if (isDeepseekModel(model) || isGlmModel(model)) {
    return REASONING_VARIANTS_NONE_HIGH_XHIGH;
  }
  if (isMuseModel(model)) {
    return REASONING_VARIANTS_NONE_MINIMAL_LOW_MEDIUM_HIGH;
  }
  return undefined;
}
