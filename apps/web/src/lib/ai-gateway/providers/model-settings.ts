import { seed_20_pro_free_model } from '@/lib/ai-gateway/providers/bytedance';
import { isGemini3Model, isGemmaModel } from '@/lib/ai-gateway/providers/google';
import { modelStartsWith } from '@/lib/ai-gateway/providers/model-prefix';
import { isMoonshotModel } from '@/lib/ai-gateway/providers/moonshotai';
import { isOpenAiModel } from '@/lib/ai-gateway/providers/openai';
import { qwen36_plus_model } from '@/lib/ai-gateway/providers/qwen';
import { isXaiModel } from '@/lib/ai-gateway/providers/xai';
import { isZaiModel } from '@/lib/ai-gateway/providers/zai';
import type {
  CustomLlmProvider,
  OpenClawModelSettings,
  OpenCodeSettings,
} from '@kilocode/db/schema-types';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';

export const REASONING_VARIANTS_BINARY = {
  instant: { reasoning: { enabled: false, effort: 'none' } },
  thinking: { reasoning: { enabled: true, effort: 'medium' } },
} as const;

export const REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH = {
  minimal: { reasoning: { enabled: true, effort: 'minimal' } },
  low: { reasoning: { enabled: true, effort: 'low' } },
  medium: { reasoning: { enabled: true, effort: 'medium' } },
  high: { reasoning: { enabled: true, effort: 'high' } },
} as const;

export function getModelVariants(model: string): OpenCodeSettings['variants'] {
  if (modelStartsWith(model, 'anthropic/claude-opus-4.7')) {
    return {
      none: { reasoning: { enabled: false, effort: 'none' } },
      low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
      medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
      high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
      xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
      max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
    };
  }
  if (modelStartsWith(model, 'anthropic/')) {
    return {
      none: { reasoning: { enabled: false, effort: 'none' } },
      low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
      medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
      high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
      max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
    };
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
    isMoonshotModel(model) ||
    isZaiModel(model) ||
    model === qwen36_plus_model.public_id ||
    isGemmaModel(model)
  ) {
    return REASONING_VARIANTS_BINARY;
  }
  if (model === seed_20_pro_free_model.public_id) {
    return {
      none: { reasoning: { enabled: false, effort: 'minimal' } },
      low: { reasoning: { enabled: true, effort: 'low' } },
      medium: { reasoning: { enabled: true, effort: 'medium' } },
      high: { reasoning: { enabled: true, effort: 'high' } },
    };
  }
  if (model.startsWith('inception/mercury-2')) {
    return {
      instant: { reasoning: { enabled: false, effort: 'none' } },
      low: { reasoning: { enabled: true, effort: 'low' } },
      medium: { reasoning: { enabled: true, effort: 'medium' } },
      high: { reasoning: { enabled: true, effort: 'high' } },
    };
  }
  if (model.startsWith('x-ai/grok-4')) {
    return {
      'non-reasoning': { reasoning: { enabled: false, effort: 'none' } },
      reasoning: { reasoning: { enabled: true, effort: 'medium' } },
    };
  }
  return undefined;
}

function getAiSdkProvider(model: string): CustomLlmProvider | undefined {
  if (qwen36_plus_model.public_id === model) {
    // with 'openai' prompt caching doesn't seem to work
    return 'openai-compatible';
  }
  if (seed_20_pro_free_model.public_id === model) {
    // with 'openai' a bunch of bugs in vercel ai sdk v5 get triggered
    return 'openai-compatible';
  }
  if (isOpenAiModel(model) || isXaiModel(model)) {
    // OpenAI: "While Chat Completions remains supported, Responses is recommended for all new projects.""
    // xAI: "The Responses API is the recommended way to interact with xAI models."
    return 'openai';
  }
  return undefined;
}

export function getOpenCodeSettings(model: string): OpenCodeSettings | undefined {
  const ai_sdk_provider = getAiSdkProvider(model);
  const variants = getModelVariants(model);
  return { ai_sdk_provider, variants };
}

export function getOpenClawSettings(model: string): OpenClawModelSettings | undefined {
  if (isOpenAiModel(model) || isXaiModel(model)) {
    return { api_adapter: 'openai-responses' };
  }
  return undefined;
}
