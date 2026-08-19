import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import {
  CLAUDE_FABLE_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID,
  CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID,
  GEMINI_PRO_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/google';
import { KIMI_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import {
  GPT_CURRENT_VERCEL_MODEL_ID,
  GPT_MINI_CURRENT_VERCEL_MODEL_ID,
} from '@/lib/ai-gateway/providers/openai';
import { inferVercelFirstPartyInferenceProviderForModel } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { GROK_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/xai';
import { GLM_CURRENT_VERCEL_MODEL_ID } from '@/lib/ai-gateway/providers/zai';
import {
  CLAUDE_FABLE_LATEST_MODEL_ALIAS,
  CLAUDE_HAIKU_LATEST_MODEL_ALIAS,
  CLAUDE_OPUS_LATEST_MODEL_ALIAS,
  CLAUDE_SONNET_LATEST_MODEL_ALIAS,
  DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS,
  GEMINI_FLASH_LATEST_MODEL_ALIAS,
  GEMINI_PRO_LATEST_MODEL_ALIAS,
  GPT_LATEST_MODEL_ALIAS,
  GPT_MINI_LATEST_MODEL_ALIAS,
  GLM_LATEST_MODEL_ALIAS,
  GROK_LATEST_MODEL_ALIAS,
  KIMI_LATEST_MODEL_ALIAS,
} from '@/lib/ai-gateway/latest-model-aliases';

const vercelModelIdMapping: Record<string, string | undefined> = {
  [CLAUDE_FABLE_LATEST_MODEL_ALIAS]: CLAUDE_FABLE_CURRENT_VERCEL_MODEL_ID,
  [CLAUDE_OPUS_LATEST_MODEL_ALIAS]: CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID,
  [CLAUDE_SONNET_LATEST_MODEL_ALIAS]: CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID,
  [CLAUDE_HAIKU_LATEST_MODEL_ALIAS]: CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID,
  [GPT_LATEST_MODEL_ALIAS]: GPT_CURRENT_VERCEL_MODEL_ID,
  [GPT_MINI_LATEST_MODEL_ALIAS]: GPT_MINI_CURRENT_VERCEL_MODEL_ID,
  [KIMI_LATEST_MODEL_ALIAS]: KIMI_CURRENT_VERCEL_MODEL_ID,
  [GEMINI_PRO_LATEST_MODEL_ALIAS]: GEMINI_PRO_CURRENT_VERCEL_MODEL_ID,
  [GEMINI_FLASH_LATEST_MODEL_ALIAS]: GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID,
  [GROK_LATEST_MODEL_ALIAS]: GROK_CURRENT_VERCEL_MODEL_ID,
  [GLM_LATEST_MODEL_ALIAS]: GLM_CURRENT_VERCEL_MODEL_ID,
  [DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS]: 'deepseek/deepseek-v4-flash-0731',
  'inclusionai/ling-3.0-flash:free': 'inclusionai/ling-3.0-flash-free',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
  'mistralai/mistral-embed-2312': 'mistral/mistral-embed',
  'mistralai/codestral-embed-2505': 'mistral/codestral-embed',
  'mistralai/ministral-14b-2512': 'mistral/ministral-14b',
  'mistralai/ministral-3b-2512': 'mistral/ministral-3b',
  'mistralai/ministral-8b-2512': 'mistral/ministral-8b',
  'mistralai/mistral-large-2512': 'mistral/mistral-large-3',
  'mistralai/mistral-medium-3-5': 'mistral/mistral-medium-3.5',
  'mistralai/mistral-small-2603': 'mistral/mistral-small',
  'mistralai/pixtral-large-2411': 'mistral/pixtral-large',
  'qwen/qwen3-14b': 'alibaba/qwen-3-14b',
  'qwen/qwen3-235b-a22b': 'alibaba/qwen-3-235b',
  'qwen/qwen3-30b-a3b': 'alibaba/qwen-3-30b',
  'qwen/qwen3-32b': 'alibaba/qwen-3-32b',
  'qwen3.8-max': 'alibaba/qwen3.8-max',
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4-6': 'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-5-20260630': 'anthropic/claude-sonnet-5',
  'claude-fable-5': 'anthropic/claude-fable-5',
  'claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-opus-5': 'anthropic/claude-opus-5',
  'claude-sonnet-4': 'anthropic/claude-sonnet-4',
  'claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
  'gemini-2.5-pro': 'google/gemini-2.5-pro',
  'gemini-3-pro-image': 'google/gemini-3-pro-image',
  'gemma-4-26b-a4b-it': 'google/gemma-4-26b-a4b-it',
  'gemma-4-31b-it': 'google/gemma-4-31b-it',
  'minimax-m2.5': 'minimax/minimax-m2.5',
  'minimax-m3': 'minimax/minimax-m3',
  'minimax/minimax-m2.5-20260211': 'minimax/minimax-m2.5',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'kimi-k3': 'moonshotai/kimi-k3',
  'gpt-3.5-turbo': 'openai/gpt-3.5-turbo',
  'gpt-4.1': 'openai/gpt-4.1',
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4o-2024-08-06': 'openai/gpt-4o',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-4o-mini-2024-07-18': 'openai/gpt-4o-mini',
  'gpt-5.1-codex': 'openai/gpt-5.1-codex',
  'gpt-5.1-codex-max': 'openai/gpt-5.1-codex-max',
  'gpt-5.1-codex-mini': 'openai/gpt-5.1-codex-mini',
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5.2-codex': 'openai/gpt-5.2-codex',
  'gpt-5.2-pro': 'openai/gpt-5.2-pro',
  'gpt-5.3-codex': 'openai/gpt-5.3-codex',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'gpt-5.4-nano': 'openai/gpt-5.4-nano',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'gpt-5-nano': 'openai/gpt-5-nano',
  'gpt-5-pro': 'openai/gpt-5-pro',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
  'gpt-oss-safeguard-20b': 'openai/gpt-oss-safeguard-20b',
  'o3-pro': 'openai/o3-pro',
  'laguna-s-2.1': 'poolside/laguna-s-2.1',
  'step-3.5-flash': 'stepfun/step-3.5-flash',
  hy3: 'tencent/hy3',
  'mimo-v2.5': 'xiaomi/mimo-v2.5',
  'glm-4.7-flash': 'zai/glm-4.7-flash',
  'glm-5.1': 'zai/glm-5.1',
  'glm-5.2': 'zai/glm-5.2',
};

export function mapModelIdToVercel(modelId: string) {
  const hardcodedVercelId = vercelModelIdMapping[modelId];
  if (hardcodedVercelId) {
    return hardcodedVercelId;
  }

  const internalId =
    kiloExclusiveModels.find(
      m =>
        m.public_id === modelId &&
        m.status !== 'disabled' &&
        (m.gateway === 'vercel' || m.flags.includes('vercel-routing'))
    )?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) {
    return internalId;
  }

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}
