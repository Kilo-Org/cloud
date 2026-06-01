import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import {
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

const vercelModelIdMapping: Record<string, string | undefined> = {
  '~anthropic/claude-opus-latest': CLAUDE_OPUS_CURRENT_VERCEL_MODEL_ID,
  '~anthropic/claude-sonnet-latest': CLAUDE_SONNET_CURRENT_VERCEL_MODEL_ID,
  '~anthropic/claude-haiku-latest': CLAUDE_HAIKU_CURRENT_VERCEL_MODEL_ID,
  '~openai/gpt-latest': GPT_CURRENT_VERCEL_MODEL_ID,
  '~openai/gpt-mini-latest': GPT_MINI_CURRENT_VERCEL_MODEL_ID,
  '~moonshotai/kimi-latest': KIMI_CURRENT_VERCEL_MODEL_ID,
  '~google/gemini-pro-latest': GEMINI_PRO_CURRENT_VERCEL_MODEL_ID,
  '~google/gemini-flash-latest': GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID,
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
  'mistralai/mistral-embed-2312': 'mistral/mistral-embed',
  'mistralai/codestral-embed-2505': 'mistral/codestral-embed',
  'x-ai/grok-4.20': 'xai/grok-4.20-reasoning',
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
};

export function mapModelIdToVercel(modelId: string, reasoningExplicitlyDisabled: boolean) {
  const hardcodedVercelId = vercelModelIdMapping[modelId];
  if (hardcodedVercelId) {
    return hardcodedVercelId === 'xai/grok-4.20-reasoning' && reasoningExplicitlyDisabled
      ? 'xai/grok-4.20-non-reasoning'
      : hardcodedVercelId;
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
