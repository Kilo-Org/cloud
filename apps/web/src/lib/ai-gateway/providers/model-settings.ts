import { isClaudeModel, isOpusModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { isGemini3Model, isGemmaModel } from '@/lib/ai-gateway/providers/google';
import { isKimiModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { isAlibabaDirectModel, qwen36_plus_stealth_model } from '@/lib/ai-gateway/providers/qwen';
import { seed_20_code_free_model } from '@/lib/ai-gateway/providers/seed';
import { isGrokModel, isGrokToggleableReasoningModel } from '@/lib/ai-gateway/providers/xai';
import { isGlmModel } from '@/lib/ai-gateway/providers/zai';
import type {
  CustomLlmProvider,
  OpenCodePrompt,
  OpenCodeSettings,
} from '@kilocode/db/schema-types';
import { isStepModel } from '@/lib/ai-gateway/providers/stepfun';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';

export const REASONING_VARIANTS_BINARY = {
  instant: { reasoning: { enabled: false, effort: 'none' } },
  thinking: { reasoning: { enabled: true, effort: 'medium' } },
} as const;

export const REASONING_VARIANTS_LOW_MEDIUM_HIGH = {
  low: { reasoning: { enabled: true, effort: 'low' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
} as const;

export const REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH = {
  minimal: { reasoning: { enabled: true, effort: 'minimal' } },
  ...REASONING_VARIANTS_LOW_MEDIUM_HIGH,
} as const;

export const REASONING_VARIANTS_NONE_LOW_MEDIUM_HIGH = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  ...REASONING_VARIANTS_LOW_MEDIUM_HIGH,
} as const;

const REASONING_VARIANTS_CLAUDE_BASE = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
  medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
  high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
} as const;

export const REASONING_VARIANTS_CLAUDE = {
  ...REASONING_VARIANTS_CLAUDE_BASE,
  max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
} as const;

export const REASONING_VARIANTS_OPUS = {
  ...REASONING_VARIANTS_CLAUDE_BASE,
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
  max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
} as const;

export const REASONING_VARIANTS_SEED = {
  none: { reasoning: { enabled: false, effort: 'minimal' } },
  ...REASONING_VARIANTS_LOW_MEDIUM_HIGH,
} as const;

export const REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH = {
  instant: REASONING_VARIANTS_BINARY.instant,
  ...REASONING_VARIANTS_LOW_MEDIUM_HIGH,
} as const;

export function getModelVariants(model: string): OpenCodeSettings['variants'] {
  if (isOpusModel(model) && (model.includes('4.7') || model.includes('4.8'))) {
    return REASONING_VARIANTS_OPUS;
  }
  if (isClaudeModel(model)) {
    return REASONING_VARIANTS_CLAUDE;
  }
  if (model.includes('codex') || isGemini3Model(model)) {
    return Object.fromEntries(
      ReasoningEffortSchema.options
        .filter(e => e !== 'none' && e !== 'minimal')
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
  if (
    isKimiModel(model) ||
    isGlmModel(model) ||
    isGrokToggleableReasoningModel(model) ||
    isAlibabaDirectModel(model) ||
    model === qwen36_plus_stealth_model.public_id ||
    isGemmaModel(model)
  ) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model === seed_20_code_free_model.public_id) {
    return REASONING_VARIANTS_SEED;
  }
  if (model.startsWith('inception/mercury-2')) {
    return REASONING_VARIANTS_INSTANT_LOW_MEDIUM_HIGH;
  }
  if (isStepModel(model)) {
    return REASONING_VARIANTS_LOW_MEDIUM_HIGH;
  }
  return undefined;
}

function getAiSdkProvider(model: string): CustomLlmProvider | undefined {
  if (isAlibabaDirectModel(model)) {
    // with 'openai' (Responses) prompt caching doesn't work
    // with 'openai-compatible' (Chat Completions) cost is wrong (cache writes are not counted)
    return 'alibaba';
  }
  if (qwen36_plus_stealth_model.public_id === model) {
    return 'openrouter';
  }
  if (seed_20_code_free_model.public_id === model) {
    // with 'openai' (Responses API) prompt caching doesn't work
    return 'openai-compatible';
  }
  if (isClaudeModel(model)) {
    // on Vercel AI Gateway, this is necessary to support document attachments
    return 'anthropic';
  }
  if (isOpenAiModel(model) || isGrokModel(model)) {
    // OpenAI: "While Chat Completions remains supported, Responses is recommended for all new projects.""
    // xAI: "The Responses API is the recommended way to interact with xAI models."
    return 'openai';
  }
  return undefined;
}

function getOpenCodePrompt(model: string): OpenCodePrompt | undefined {
  if (model.includes('gpt-5.5')) {
    return 'gpt55';
  }
  return undefined;
}

export function getOpenCodeSettings(model: string): OpenCodeSettings | undefined {
  const ai_sdk_provider = getAiSdkProvider(model);
  const variants = getModelVariants(model);
  const prompt = getOpenCodePrompt(model);
  return { ai_sdk_provider, variants, prompt };
}
