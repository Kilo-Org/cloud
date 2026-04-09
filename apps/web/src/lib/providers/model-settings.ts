import { seed_20_pro_free_model } from '@/lib/providers/bytedance';
import { isGemini3Model, isGeminiModel } from '@/lib/providers/google';
import { isMinimaxModel } from '@/lib/providers/minimax';
import { isMoonshotModel } from '@/lib/providers/moonshotai';
import { isOpenAiModel } from '@/lib/providers/openai';
import { qwen36_plus_model } from '@/lib/providers/qwen';
import { isXaiModel } from '@/lib/providers/xai';
import { isXiaomiModel } from '@/lib/providers/xiaomi';
import { isZaiModel } from '@/lib/providers/zai';
import type {
  CustomLlmProvider,
  ModelSettings,
  OpenCodeSettings,
  VersionedSettings,
} from '@kilocode/db/schema-types';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';

export function getModelSettings(model: string): ModelSettings | undefined {
  if (isOpenAiModel(model)) {
    return {
      included_tools: ['apply_patch'],
      excluded_tools: ['apply_diff', 'delete_file', 'edit_file', 'write_to_file'],
    };
  }
  if (isMinimaxModel(model)) {
    return {
      included_tools: ['search_and_replace'],
      excluded_tools: ['apply_diff', 'edit_file'],
    };
  }
  return undefined;
}

export function getVersionedModelSettings(model: string): VersionedSettings | undefined {
  if (isGeminiModel(model) || isZaiModel(model)) {
    return {
      '4.146.0': {
        included_tools: ['write_file', 'edit_file'],
        excluded_tools: ['apply_diff'],
      },
    };
  }
  return undefined;
}

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
  // Inlined to avoid importing anthropic.ts (which transitively pulls in Node.js crypto)
  if (model.startsWith('anthropic/')) {
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
    isXiaomiModel(model) ||
    model === qwen36_plus_model.public_id
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
