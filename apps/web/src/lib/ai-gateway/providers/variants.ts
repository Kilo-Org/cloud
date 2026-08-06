import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { isDeepseekModel } from '@/lib/ai-gateway/providers/deepseek';
import { isGeminiModel } from '@/lib/ai-gateway/providers/google';
import { isMuseModel } from '@/lib/ai-gateway/providers/meta';
import { isMinimaxModel } from '@/lib/ai-gateway/providers/minimax';
import { isMistralModel } from '@/lib/ai-gateway/providers/mistral';
import { isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { isQwenModel } from '@/lib/ai-gateway/providers/qwen';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { isGrokModel } from '@/lib/ai-gateway/providers/xai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import { type OpenCodeSettings, ReasoningEffortSchema } from '@kilocode/db/schema-types';

export const REASONING_VARIANTS_THINKING_ONLY = {
  thinking: { reasoning: { enabled: true, effort: 'high' } },
} as const;

export const REASONING_VARIANTS_BINARY = {
  instant: { reasoning: { enabled: false, effort: 'none' } },
  thinking: { reasoning: { enabled: true, effort: 'high' } },
} as const;

export const REASONING_VARIANTS_LOW_MEDIUM_HIGH = {
  high: { reasoning: { enabled: true, effort: 'high' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
} as const;

export const REASONING_VARIANTS_MAX_HIGH_LOW_NONE = {
  max: { reasoning: { enabled: true, effort: 'max' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
  none: { reasoning: { enabled: false, effort: 'none' } },
} as const;

export const REASONING_VARIANTS_XHIGH_HIGH_MEDIUM_LOW_MINIMAL = {
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
  minimal: { reasoning: { enabled: true, effort: 'minimal' } },
} as const;

export const REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH = {
  high: { reasoning: { enabled: true, effort: 'high' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
  minimal: { reasoning: { enabled: true, effort: 'minimal' } },
} as const;

export const REASONING_VARIANTS_NONE_MINIMAL_LOW_MEDIUM_HIGH_XHIGH = {
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
  minimal: { reasoning: { enabled: true, effort: 'minimal' } },
  none: { reasoning: { enabled: false, effort: 'none' } },
} as const;

export const REASONING_VARIANTS_NONE_HIGH_XHIGH = {
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  none: { reasoning: { enabled: false, effort: 'none' } },
} as const;

export const REASONING_VARIANTS_NONE_MEDIUM_HIGH = {
  high: { reasoning: { enabled: true, effort: 'high' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  none: { reasoning: { enabled: false, effort: 'none' } },
} as const;

export const REASONING_VARIANTS_NONE_LOW_HIGH_MAX = {
  max: { reasoning: { enabled: true, effort: 'max' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
  none: { reasoning: { enabled: false, effort: 'none' } },
} as const;

const REASONING_VARIANTS_CLAUDE = {
  max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
  high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
  medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
  low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
  none: { reasoning: { enabled: false, effort: 'none' } },
} as const;

export const REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH = {
  instant: { reasoning: { enabled: false, effort: 'none' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
} as const;

export function getFallbackModelVariants(model: string): OpenCodeSettings['variants'] {
  if (isClaudeModel(model)) {
    return REASONING_VARIANTS_CLAUDE;
  }
  if (isDeepseekModel(model)) {
    return REASONING_VARIANTS_NONE_LOW_HIGH_MAX;
  }
  if (model.includes('gemma')) {
    return REASONING_VARIANTS_BINARY;
  }
  if (isGeminiModel(model)) {
    return REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH;
  }
  if (isGlmModel(model)) {
    return REASONING_VARIANTS_NONE_HIGH_XHIGH;
  }
  if (isGrokModel(model)) {
    return REASONING_VARIANTS_LOW_MEDIUM_HIGH;
  }
  if (isKimiModel(model)) {
    return REASONING_VARIANTS_MAX_HIGH_LOW_NONE;
  }
  if (model.includes('laguna')) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model.includes('ling-')) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model.includes('mercury')) {
    return REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH;
  }
  if (isMinimaxModel(model)) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model.includes('mimo')) {
    return REASONING_VARIANTS_BINARY;
  }
  if (isMistralModel(model)) {
    return REASONING_VARIANTS_BINARY;
  }
  if (isMuseModel(model)) {
    return REASONING_VARIANTS_NONE_MINIMAL_LOW_MEDIUM_HIGH_XHIGH;
  }
  if (model.includes('nemotron')) {
    return REASONING_VARIANTS_NONE_MEDIUM_HIGH;
  }
  if (isOpenAiModel(model)) {
    return Object.fromEntries(
      ReasoningEffortSchema.options
        .filter(e => e !== 'minimal')
        .reverse()
        .map(effort => [effort, { reasoning: { enabled: effort !== 'none', effort } }])
    );
  }
  if (isQwenModel(model)) {
    return REASONING_VARIANTS_XHIGH_HIGH_MEDIUM_LOW_MINIMAL;
  }
  if (isStepModel(model)) {
    return REASONING_VARIANTS_LOW_MEDIUM_HIGH;
  }
  return undefined;
}
