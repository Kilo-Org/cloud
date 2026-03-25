import type { FeatureValue } from '@/lib/feature-detection';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_NAME,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_NAME,
} from '@/lib/providers/anthropic';
import {
  MINIMAX_CURRENT_MODEL_ID,
  MINIMAX_CURRENT_MODEL_NAME,
  minimax_m25_free_model,
} from '@/lib/providers/minimax';
import { KIMI_CURRENT_MODEL_ID, KIMI_CURRENT_MODEL_NAME } from '@/lib/providers/moonshotai';
import { gpt_oss_20b_free_model, GPT_5_NANO_ID, GPT_5_NANO_NAME } from '@/lib/providers/openai';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterReasoningConfig,
} from '@/lib/providers/openrouter/types';
import type { ModelSettings, OpenCodeSettings, Verbosity } from '@kilocode/db/schema-types';
import type OpenAI from 'openai';

function stripDisplayName(displayName: string): string {
  const start = displayName.indexOf(': ');
  const end = displayName.indexOf(' (');
  return displayName.substring(start < 0 ? 0 : start + 2, end < 0 ? undefined : end);
}

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

type ResolvedAutoModel = {
  model: string;
  reasoning?: OpenRouterReasoningConfig;
  verbosity?: Verbosity;
};

const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  [CLAUDE_OPUS_CURRENT_MODEL_ID]: CLAUDE_OPUS_CURRENT_MODEL_NAME,
  [CLAUDE_SONNET_CURRENT_MODEL_ID]: CLAUDE_SONNET_CURRENT_MODEL_NAME,
  [KIMI_CURRENT_MODEL_ID]: KIMI_CURRENT_MODEL_NAME,
  [MINIMAX_CURRENT_MODEL_ID]: MINIMAX_CURRENT_MODEL_NAME,
};

function describeRouting(modeToModel: Record<string, ResolvedAutoModel>): string {
  const modelToModes: Record<string, string[]> = {};
  for (const [mode, { model }] of Object.entries(modeToModel)) {
    const modes = modelToModes[model] ?? [];
    modes.push(mode);
    modelToModes[model] = modes;
  }
  const parts = Object.entries(modelToModes).map(
    ([model, modes]) => `${MODEL_DISPLAY_NAMES[model] ?? model} for ${modes.join(', ')}`
  );
  return `Uses ${parts.join('; ')}.`;
}

const FRONTIER_CODE_MODEL: ResolvedAutoModel = {
  model: CLAUDE_SONNET_CURRENT_MODEL_ID,
  reasoning: { enabled: true },
  verbosity: 'low',
};

const FRONTIER_MODE_TO_MODEL: Record<string, ResolvedAutoModel> = {
  plan: { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  general: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'medium',
  },
  architect: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  orchestrator: {
    model: CLAUDE_OPUS_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'high',
  },
  ask: { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  debug: { model: CLAUDE_OPUS_CURRENT_MODEL_ID, reasoning: { enabled: true }, verbosity: 'high' },
  build: {
    model: CLAUDE_SONNET_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'medium',
  },
  explore: {
    model: CLAUDE_SONNET_CURRENT_MODEL_ID,
    reasoning: { enabled: true },
    verbosity: 'medium',
  },
  code: FRONTIER_CODE_MODEL,
};

const BALANCED_CODE_MODEL: ResolvedAutoModel = {
  model: MINIMAX_CURRENT_MODEL_ID,
};

const BALANCED_MODE_TO_MODEL: Record<string, ResolvedAutoModel> = {
  plan: { model: KIMI_CURRENT_MODEL_ID, reasoning: { enabled: true } },
  general: { model: KIMI_CURRENT_MODEL_ID, reasoning: { enabled: true } },
  architect: { model: KIMI_CURRENT_MODEL_ID, reasoning: { enabled: true } },
  orchestrator: { model: KIMI_CURRENT_MODEL_ID, reasoning: { enabled: true } },
  ask: { model: KIMI_CURRENT_MODEL_ID, reasoning: { enabled: true } },
  debug: { model: KIMI_CURRENT_MODEL_ID, reasoning: { enabled: true } },
  build: { model: MINIMAX_CURRENT_MODEL_ID },
  explore: { model: MINIMAX_CURRENT_MODEL_ID },
  code: BALANCED_CODE_MODEL,
};

export const KILO_AUTO_FRONTIER_MODEL: AutoModel = {
  id: 'kilo-auto/frontier',
  name: 'Kilo Auto Frontier',
  description: `Highest performance and capability for any task. ${describeRouting(FRONTIER_MODE_TO_MODEL)}`,
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
  description: `Free with limited capability. No credits required. Uses ${stripDisplayName(minimax_m25_free_model.display_name)}.`,
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
  description: `Great balance of price and capability. ${describeRouting(BALANCED_MODE_TO_MODEL)}`,
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
  description: `Automatically routes your request to a small model. Uses ${GPT_5_NANO_NAME} (default) or ${stripDisplayName(gpt_oss_20b_free_model.display_name)} (free fallback).`,
  context_length: 131072,
  max_completion_tokens: 32768,
  prompt_price: '0.00000005',
  completion_price: '0.0000004',
  supports_images: false,
  roocode_settings: undefined,
  opencode_settings: undefined,
};

export const AUTO_MODELS = [
  KILO_AUTO_FRONTIER_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
];

export function isKiloAutoModel(model: string) {
  return (
    AUTO_MODELS.some(m => m.id === model) ||
    (Object.hasOwn(legacyMapping, model) && legacyMapping[model] !== undefined)
  );
}

export const KILO_AUTO_FREE_MODEL_DEPRECATED = 'kilo/auto-free';

const legacyMapping: Record<string, AutoModel | undefined> = {
  'kilo/auto': KILO_AUTO_FRONTIER_MODEL,
  [KILO_AUTO_FREE_MODEL_DEPRECATED]: KILO_AUTO_FREE_MODEL,
  'kilo/auto-small': KILO_AUTO_SMALL_MODEL,
};

export async function resolveAutoModel(
  model: string,
  modeHeader: string | null,
  balancePromise: Promise<number>
): Promise<ResolvedAutoModel> {
  const mappedModel =
    (Object.hasOwn(legacyMapping, model) ? legacyMapping[model] : null)?.id ?? model;
  if (mappedModel === KILO_AUTO_FREE_MODEL.id) {
    return { model: minimax_m25_free_model.public_id };
  }
  if (mappedModel === KILO_AUTO_SMALL_MODEL.id) {
    return {
      model: (await balancePromise) > 0 ? GPT_5_NANO_ID : gpt_oss_20b_free_model.public_id,
    };
  }
  const mode = modeHeader?.trim().toLowerCase() ?? '';
  if (mappedModel === KILO_AUTO_BALANCED_MODEL.id) {
    return (
      (Object.hasOwn(BALANCED_MODE_TO_MODEL, mode) ? BALANCED_MODE_TO_MODEL[mode] : null) ??
      BALANCED_CODE_MODEL
    );
  }
  return (
    (Object.hasOwn(FRONTIER_MODE_TO_MODEL, mode) ? FRONTIER_MODE_TO_MODEL[mode] : null) ??
    FRONTIER_CODE_MODEL
  );
}

export async function applyResolvedAutoModel(
  model: string,
  request: GatewayRequest,
  modeHeader: string | null,
  featureHeader: FeatureValue | null,
  balancePromise: Promise<number>
) {
  const resolved = await resolveAutoModel(
    model,
    featureHeader === 'kiloclaw' ? 'plan' : modeHeader,
    balancePromise
  );
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
