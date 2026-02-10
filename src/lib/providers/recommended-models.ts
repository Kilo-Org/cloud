import type { ModelSettings, VersionedSettings } from '@/lib/organizations/organization-types';
import { KILO_AUTO_MODEL_ID } from '@/lib/kilo-auto-model';
import { giga_potato_model } from '@/lib/providers/gigapotato';
import { minimax_m21_free_model } from '@/lib/providers/minimax';
import { zai_glm47_free_model } from '@/lib/providers/zai';
import { grok_code_fast_1_optimized_free_model } from '@/lib/providers/xai';

export type RecommendedModel = {
  public_id: string;
  tool_choice_required: boolean;
  random_vercel_routing: boolean;
};

export const recommendedModels = [
  {
    public_id: KILO_AUTO_MODEL_ID,
    tool_choice_required: false,
    random_vercel_routing: true,
  },
  {
    public_id: minimax_m21_free_model.is_enabled
      ? minimax_m21_free_model.public_id
      : 'minimax/minimax-m2.1',
    tool_choice_required: false,
    random_vercel_routing: true,
  },
  {
    public_id: zai_glm47_free_model.is_enabled ? zai_glm47_free_model.public_id : 'z-ai/glm-4.7',
    tool_choice_required: false,
    random_vercel_routing: true,
  },
  {
    public_id: 'moonshotai/kimi-k2.5',
    tool_choice_required: false,
    random_vercel_routing: false,
  },
  {
    public_id: 'openrouter/pony-alpha',
    tool_choice_required: false,
    random_vercel_routing: false,
  },
  {
    public_id: giga_potato_model.public_id,
    tool_choice_required: false,
    random_vercel_routing: false,
  },
  {
    public_id: 'arcee-ai/trinity-large-preview:free',
    tool_choice_required: false,
    random_vercel_routing: true,
  },
  {
    public_id: 'anthropic/claude-opus-4.6',
    tool_choice_required: false,
    random_vercel_routing: false, // not yet allowed pending strict tool use support
  },
  {
    public_id: 'anthropic/claude-sonnet-4.5',
    tool_choice_required: false,
    random_vercel_routing: false,
  },
  {
    public_id: 'anthropic/claude-haiku-4.5',
    tool_choice_required: true,
    random_vercel_routing: false,
  },
  {
    public_id: 'openai/gpt-5.2',
    tool_choice_required: true,
    random_vercel_routing: true,
  },
  {
    public_id: 'openai/gpt-5.2-codex',
    tool_choice_required: true,
    random_vercel_routing: true,
  },
  {
    public_id: 'google/gemini-3-pro-preview',
    tool_choice_required: true,
    random_vercel_routing: true,
  },
  {
    public_id: 'google/gemini-3-flash-preview',
    tool_choice_required: true,
    random_vercel_routing: true,
  },
  {
    public_id: grok_code_fast_1_optimized_free_model.is_enabled
      ? grok_code_fast_1_optimized_free_model.public_id
      : 'x-ai/grok-code-fast-1',
    tool_choice_required: true, // https://kilo-code.slack.com/archives/C09922UFQHF/p1768002096163529?thread_ts=1767889912.400579&cid=C09922UFQHF
    random_vercel_routing: true,
  },
] satisfies RecommendedModel[];

export function getModelSettings(model: string): ModelSettings | undefined {
  if (model.startsWith('openai/') && !model.startsWith('openai/gpt-oss')) {
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
    model === giga_potato_model.public_id
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
