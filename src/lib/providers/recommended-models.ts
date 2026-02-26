import type {
  ModelSettings,
  OpenCodeSettings,
  VersionedSettings,
} from '@/lib/organizations/model-settings';
import { isAnthropicModel } from '@/lib/providers/anthropic';
import { giga_potato_model, giga_potato_thinking_model } from '@/lib/providers/gigapotato';
import { isOpenAiModel } from '@/lib/providers/openai';

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
    model.startsWith('google/gemini') ||
    model.startsWith('z-ai/') ||
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

export function getOpenCodeSettings(model: string): OpenCodeSettings | undefined {
  if (isAnthropicModel(model)) {
    return {
      variants: {
        none: { reasoning: { enabled: false } },
        low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
        medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
        high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
        max: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'max' },
      },
    };
  }
  return undefined;
}
