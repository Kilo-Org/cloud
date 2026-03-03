import { isAnthropicModel } from '@/lib/providers/anthropic';
import { giga_potato_model, giga_potato_thinking_model } from '@/lib/providers/gigapotato';
import { isGemini3Model, isGeminiModel } from '@/lib/providers/google';
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
  if (model.startsWith('minimax/')) {
    return {
      included_tools: ['search_and_replace'],
      excluded_tools: ['apply_diff', 'edit_file'],
    };
  }
  return undefined;
}

export function getVersionedModelSettings(model: string): VersionedSettings | undefined {
  if (
    isGeminiModel(model) ||
    isZaiModel(model) ||
    model === giga_potato_model.public_id ||
    model === giga_potato_thinking_model.public_id
  ) {
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
  if (isAnthropicModel(model)) {
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
  return undefined;
}

export function getOpenCodeSettings(model: string): OpenCodeSettings | undefined {
  const variants = getModelVariants(model);
  if (variants) {
    return { variants };
  }
  return undefined;
}
