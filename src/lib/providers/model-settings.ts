import { isGemini3Model, isGeminiModel } from '@/lib/providers/google';
import { isMinimaxModel } from '@/lib/providers/minimax';
import { isMoonshotModel } from '@/lib/providers/moonshotai';
import { isOpenAiModel } from '@/lib/providers/openai';
import { isZaiModel } from '@/lib/providers/zai';
import type { ModelSettings, OpenCodeSettings, VersionedSettings } from '@kilocode/db/schema-types';
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
    const efforts = model.includes('codex')
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

export function getOpenCodeSettings(model: string): OpenCodeSettings | undefined {
  const variants = getModelVariants(model);
  if (variants) {
    return { variants };
  }
  return undefined;
}
