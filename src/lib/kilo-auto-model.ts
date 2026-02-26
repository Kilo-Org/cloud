import type { ModelSettings, OpenCodeSettings } from '@/lib/organizations/model-settings';
import { minimax_m25_free_model } from '@/lib/providers/minimax';

type AutoModel = {
  id: string;
  name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  prompt_price: string;
  completion_price: string;
  supports_images: boolean;
  roocode_settings: ModelSettings | undefined;
  opencode_settings: OpenCodeSettings | undefined;
};

export const KILO_AUTO_FRONTIER_MODEL: AutoModel = {
  id: 'kilo/auto',
  name: 'Kilo: Auto',
  description: 'Automatically routes your request to the best model for the task.',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  prompt_price: '0.000005',
  completion_price: '0.000025',
  supports_images: true,
  roocode_settings: undefined,
  opencode_settings: {
    family: 'claude',
    prompt: 'anthropic',
  },
};

export const KILO_AUTO_FREE_MODEL: AutoModel = {
  id: 'kilo/auto-free',
  name: 'Kilo: Auto Free',
  description: 'Automatically routes your request to a free model.',
  context_length: minimax_m25_free_model.context_length,
  max_completion_tokens: minimax_m25_free_model.max_completion_tokens,
  prompt_price: '0',
  completion_price: '0',
  supports_images: false,
  roocode_settings: {
    included_tools: ['search_and_replace'],
    excluded_tools: ['apply_diff', 'edit_file'],
  },
  opencode_settings: undefined,
};

export const KILO_AUTO_SMALL_MODEL: AutoModel = {
  id: 'kilo/auto-small',
  name: 'Kilo: Auto Small',
  description: 'Automatically routes your request to a small model.',
  context_length: 400_000,
  max_completion_tokens: 128_000,
  prompt_price: '0.00000005',
  completion_price: '0.0000004',
  supports_images: true,
  roocode_settings: undefined,
  opencode_settings: {
    family: 'gpt',
    prompt: 'codex',
  },
};

export const AUTO_MODELS = [KILO_AUTO_FRONTIER_MODEL, KILO_AUTO_FREE_MODEL, KILO_AUTO_SMALL_MODEL];

export function isKiloAutoModel(model: string) {
  return AUTO_MODELS.some(m => m.id === model);
}
