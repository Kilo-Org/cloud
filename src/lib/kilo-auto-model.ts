import type { FeatureValue } from '@/lib/feature-detection';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/providers/anthropic';
import { minimax_m25_free_model } from '@/lib/providers/minimax';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterReasoningConfig,
} from '@/lib/providers/openrouter/types';
import type { ModelSettings, OpenCodeSettings, Verbosity } from '@kilocode/db/schema-types';
import type OpenAI from 'openai';

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
  id: 'kilo-auto/frontier',
  name: 'Kilo Auto Frontier',
  description: 'Highest performance and capability for any task.',
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
  id: 'kilo-auto/free',
  name: 'Kilo Auto Free',
  description: 'Free with limited capability. No credits required.',
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

export const KILO_AUTO_BALANCED_MODEL: AutoModel = {
  id: 'kilo-auto/balanced',
  name: 'Kilo Auto Balanced',
  description: 'Great balance of price and capability.',
  context_length: 204800,
  max_completion_tokens: 131072,
  prompt_price: '0.0000006',
  completion_price: '0.000003',
  supports_images: false,
  roocode_settings: {
    included_tools: ['edit_file'],
    excluded_tools: ['apply_diff'],
  },
  opencode_settings: undefined,
};

export const KILO_AUTO_SMALL_MODEL: AutoModel = {
  id: 'kilo-auto/small',
  name: 'Kilo Auto Small',
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

export const AUTO_MODELS = [
  KILO_AUTO_FRONTIER_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
];

export function isKiloAutoModel(model: string) {
  return AUTO_MODELS.some(m => m.id === model) || legacyMapping[model] !== undefined;
}

type ResolvedAutoModel = {
  model: string;
  reasoning?: OpenRouterReasoningConfig;
  verbosity?: Verbosity;
};

const FRONTIER_CODE_MODEL: ResolvedAutoModel = {
  model: CLAUDE_SONNET_CURRENT_MODEL_ID,
  reasoning: { enabled: true },
  verbosity: 'low',
};

// Mode → model mappings for kilo-auto/frontier routing.
// Add/remove/modify entries here to change routing behavior.
const FRONTIER_MODE_TO_MODEL = new Map<string, ResolvedAutoModel>([
  // Opus modes (planning, reasoning, orchestration, debugging)
  [
    'plan',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  [
    'general',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'medium' },
  ],
  [
    'architect',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  [
    'orchestrator',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  ['ask', { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' }],
  [
    'debug',
    { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  ],
  // Sonnet modes (implementation, exploration)
  [
    'build',
    { model: CLAUDE_SONNET_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'medium' },
  ],
  [
    'explore',
    { model: CLAUDE_SONNET_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'medium' },
  ],
  ['code', FRONTIER_CODE_MODEL],
]);

const KIMI_K25_MODEL_ID = 'moonshotai/kimi-k2.5';

const MINIMAX_M27_MODEL_ID = 'minimax/minimax-m2.7';

const BALANCED_CODE_MODEL: ResolvedAutoModel = {
  model: MINIMAX_M27_MODEL_ID,
};

// Mode → model mappings for kilo-auto/balanced routing.
// Uses Kimi K2.5 where Frontier uses Opus, Minimax M2.7 where Frontier uses Sonnet.
const BALANCED_MODE_TO_MODEL = new Map<string, ResolvedAutoModel>([
  ['plan', { model: KIMI_K25_MODEL_ID, reasoning: { enabled: true } }],
  ['general', { model: KIMI_K25_MODEL_ID, reasoning: { enabled: true } }],
  ['architect', { model: KIMI_K25_MODEL_ID, reasoning: { enabled: true } }],
  ['orchestrator', { model: KIMI_K25_MODEL_ID, reasoning: { enabled: true } }],
  ['ask', { model: KIMI_K25_MODEL_ID, reasoning: { enabled: true } }],
  ['debug', { model: KIMI_K25_MODEL_ID, reasoning: { enabled: true } }],
  ['build', { model: MINIMAX_M27_MODEL_ID }],
  ['explore', { model: MINIMAX_M27_MODEL_ID }],
  ['code', BALANCED_CODE_MODEL],
]);

export const KILO_AUTO_FREE_MODEL_DEPRECATED = 'kilo/auto-free';

const legacyMapping: Record<string, AutoModel | undefined> = {
  'kilo/auto': KILO_AUTO_FRONTIER_MODEL,
  [KILO_AUTO_FREE_MODEL_DEPRECATED]: KILO_AUTO_FREE_MODEL,
  'kilo/auto-small': KILO_AUTO_SMALL_MODEL,
};

export function resolveAutoModel(model: string, modeHeader: string | null): ResolvedAutoModel {
  const mappedModel = legacyMapping[model]?.id ?? model;
  if (mappedModel === KILO_AUTO_FREE_MODEL.id) {
    return { model: minimax_m25_free_model.public_id };
  }
  if (mappedModel === KILO_AUTO_SMALL_MODEL.id) {
    return { model: 'openai/gpt-5-nano' };
  }
  const mode = modeHeader?.trim().toLowerCase() ?? '';
  if (mappedModel === KILO_AUTO_BALANCED_MODEL.id) {
    return BALANCED_MODE_TO_MODEL.get(mode) ?? BALANCED_CODE_MODEL;
  }
  return FRONTIER_MODE_TO_MODEL.get(mode) ?? FRONTIER_CODE_MODEL;
}

export function applyResolvedAutoModel(
  model: string,
  request: GatewayRequest,
  modeHeader: string | null,
  featureHeader: FeatureValue | null
) {
  const resolved = resolveAutoModel(model, featureHeader === 'kiloclaw' ? 'plan' : modeHeader);
  request.body.model = resolved.model;
  if (resolved.reasoning) {
    if (request.kind === 'messages') {
      request.body.thinking = { type: resolved.reasoning.enabled ? 'adaptive' : 'disabled' };
    } else {
      request.body.reasoning = resolved.reasoning;
    }
  }
  if (resolved.verbosity) {
    if (request.kind === 'messages') {
      request.body.output_config = {
        ...request.body.output_config,
        effort: resolved.verbosity,
      };
    } else if (request.kind === 'responses') {
      request.body.text = {
        ...request.body.text,
        verbosity: resolved.verbosity as OpenAI.Responses.ResponseTextConfig['verbosity'],
      };
    } else {
      request.body.verbosity = resolved.verbosity as OpenRouterChatCompletionRequest['verbosity'];
    }
  }
}
