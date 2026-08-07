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
import {
  CLAUDE_FABLE_LATEST_MODEL_ALIAS,
  CLAUDE_HAIKU_LATEST_MODEL_ALIAS,
  CLAUDE_OPUS_LATEST_MODEL_ALIAS,
  CLAUDE_SONNET_LATEST_MODEL_ALIAS,
  GEMINI_FLASH_LATEST_MODEL_ALIAS,
  GEMINI_PRO_LATEST_MODEL_ALIAS,
  GPT_LATEST_MODEL_ALIAS,
  GPT_MINI_LATEST_MODEL_ALIAS,
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
  'deepseek/deepseek-v4-flash-latest': 'deepseek/deepseek-v4-flash-0731',
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
