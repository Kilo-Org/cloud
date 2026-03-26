import { seed_20_pro_free_model } from '@/lib/providers/bytedance';
import { isGemini3Model, isGeminiModel } from '@/lib/providers/google';
import { isMinimaxModel } from '@/lib/providers/minimax';
import { isMoonshotModel } from '@/lib/providers/moonshotai';
import { isOpenAiModel } from '@/lib/providers/openai';
import { qwen35_plus_free_model } from '@/lib/providers/qwen';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';
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

export function getModelVariants(model: string): OpenCodeSettings['variants'] {
  // Inlined to avoid importing anthropic.ts (which transitively pulls in Node.js crypto)
  if (model.startsWith('anthropic/')) {
    return {
      none: { reasoning: { enabled: false } },
      low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
      medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
      high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
      max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
    };
  }
  if (isOpenAiModel(model) || isGemini3Model(model)) {
    const filterNone = model.includes('codex') || isGemini3Model(model);
    const efforts = filterNone
      ? ReasoningEffortSchema.options.filter(e => e !== 'none')
      : ReasoningEffortSchema.options;
    return Object.fromEntries(
      efforts.map(effort => [effort, { reasoning: { enabled: effort !== 'none', effort } }])
    );
  }
  if (isMoonshotModel(model) || isZaiModel(model)) {
    return {
      instant: { reasoning: { enabled: false } },
      thinking: { reasoning: { enabled: true } },
    };
  }
  if (model.startsWith('inception/mercury-2')) {
    return {
      instant: { reasoning: { enabled: false } },
      low: { reasoning: { enabled: true, effort: 'low' } },
      medium: { reasoning: { enabled: true, effort: 'medium' } },
      high: { reasoning: { enabled: true, effort: 'high' } },
    };
  }
  if (model.startsWith('x-ai/grok-4')) {
    return {
      'non-reasoning': { reasoning: { enabled: false } },
      reasoning: { reasoning: { enabled: true } },
    };
  }
  return undefined;
}

function getAiSdkProvider(model: string): CustomLlmProvider | undefined {
  if (qwen35_plus_free_model.public_id === model) {
    // with 'openai' prompt caching doesn't seem to work
    return 'openai-compatible';
  }
  if (seed_20_pro_free_model.public_id === model) {
    // with 'openai' a bunch of bugs in vercel ai sdk v5 get triggered
    return 'openai-compatible';
  }
  if (grok_code_fast_1_optimized_free_model.public_id === model) {
    return 'openai';
  }
  return undefined;
}

export function getOpenCodeSettings(model: string): OpenCodeSettings | undefined {
  const ai_sdk_provider = getAiSdkProvider(model);
  const variants = getModelVariants(model);
  return { ai_sdk_provider, variants };
}
