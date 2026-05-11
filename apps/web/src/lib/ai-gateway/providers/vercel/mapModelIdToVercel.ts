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
  'x-ai/grok-3-beta': 'xai/grok-3',
  'x-ai/grok-3-mini-beta': 'xai/grok-3-mini',
  'x-ai/grok-4-fast': 'xai/grok-4-fast-reasoning',
  'x-ai/grok-4.1-fast': 'xai/grok-4.1-fast-reasoning',
  'x-ai/grok-4.20': 'xai/grok-4.20-reasoning',
  'mistralai/ministral-14b-2512': 'mistral/ministral-14b',
  'mistralai/ministral-3b-2512': 'mistral/ministral-3b',
  'mistralai/ministral-8b-2512': 'mistral/ministral-8b',
  'mistralai/mistral-large-2512': 'mistral/mistral-large-3',
  'mistralai/mistral-medium-3': 'mistral/mistral-medium',
  'mistralai/mistral-medium-3.1': 'mistral/mistral-medium',
  'mistralai/mistral-medium-3-5': 'mistral/mistral-medium',
  'mistralai/mistral-small-2603': 'mistral/mistral-small',
  'mistralai/pixtral-large-2411': 'mistral/pixtral-large',
  'qwen/qwen3-14b': 'alibaba/qwen-3-14b',
  'qwen/qwen3-235b-a22b': 'alibaba/qwen-3-235b',
  'qwen/qwen3-235b-a22b-2507': 'alibaba/qwen-3-235b',
  'qwen/qwen3-235b-a22b-thinking-2507': 'alibaba/qwen3-235b-a22b-thinking',
  'qwen/qwen3-30b-a3b': 'alibaba/qwen-3-30b',
  'qwen/qwen3-30b-a3b-instruct-2507': 'alibaba/qwen-3-30b',
  'qwen/qwen3-32b': 'alibaba/qwen-3-32b',
  'qwen/qwen3-coder:free': 'alibaba/qwen3-coder',
  'qwen/qwen3-coder-30b-a3b-instruct': 'alibaba/qwen3-coder-30b-a3b',
  'qwen/qwen3-next-80b-a3b-instruct:free': 'alibaba/qwen3-next-80b-a3b-instruct',
  'qwen/qwen3-vl-235b-a22b-thinking': 'alibaba/qwen3-vl-thinking',
  'qwen/qwen3.6-max-preview': 'alibaba/qwen-3.6-max-preview',
  'anthropic/claude-opus-4.6-fast': 'anthropic/claude-opus-4.6',
  'amazon/nova-2-lite-v1': 'amazon/nova-2-lite',
  'amazon/nova-lite-v1': 'amazon/nova-lite',
  'amazon/nova-micro-v1': 'amazon/nova-micro',
  'amazon/nova-pro-v1': 'amazon/nova-pro',
  'bytedance-seed/seed-1.6': 'bytedance/seed-1.6',
  'deepseek/deepseek-chat': 'deepseek/deepseek-v3',
  'deepseek/deepseek-chat-v3.1': 'deepseek/deepseek-v3.1',
  'deepseek/deepseek-v3.2-exp': 'deepseek/deepseek-v3.2',
  'google/gemini-2.0-flash-001': 'google/gemini-2.0-flash',
  'google/gemini-2.0-flash-lite-001': 'google/gemini-2.0-flash-lite',
  'google/gemini-2.5-pro-preview': 'google/gemini-2.5-pro',
  'google/gemini-3-flash-preview': 'google/gemini-3-flash',
  'google/gemini-3-pro-image-preview': 'google/gemini-3-pro-image',
  'google/gemini-3.1-pro-preview-customtools': 'google/gemini-3.1-pro-preview',
  'google/gemma-4-26b-a4b-it:free': 'google/gemma-4-26b-a4b-it',
  'google/gemma-4-31b-it:free': 'google/gemma-4-31b-it',
  'meta-llama/llama-3.1-70b-instruct': 'meta/llama-3.1-70b',
  'meta-llama/llama-3.1-8b-instruct': 'meta/llama-3.1-8b',
  'meta-llama/llama-3.2-1b-instruct': 'meta/llama-3.2-1b',
  'meta-llama/llama-3.2-3b-instruct': 'meta/llama-3.2-3b',
  'meta-llama/llama-3.2-3b-instruct:free': 'meta/llama-3.2-3b',
  'meta-llama/llama-3.2-11b-vision-instruct': 'meta/llama-3.2-11b',
  'meta-llama/llama-3.3-70b-instruct': 'meta/llama-3.3-70b',
  'meta-llama/llama-3.3-70b-instruct:free': 'meta/llama-3.3-70b',
  'meta-llama/llama-4-maverick': 'meta/llama-4-maverick',
  'meta-llama/llama-4-scout': 'meta/llama-4-scout',
  'minimax/minimax-m2.5:free': 'minimax/minimax-m2.5',
  'nvidia/nemotron-3-nano-30b-a3b:free': 'nvidia/nemotron-3-nano-30b-a3b',
  'nvidia/nemotron-3-super-120b-a12b:free': 'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-nano-12b-v2-vl:free': 'nvidia/nemotron-nano-12b-v2-vl',
  'nvidia/nemotron-nano-9b-v2:free': 'nvidia/nemotron-nano-9b-v2',
  'openai/gpt-oss-120b:free': 'openai/gpt-oss-120b',
  'openai/gpt-oss-20b:free': 'openai/gpt-oss-20b',
  'z-ai/glm-4.5-air:free': 'zai/glm-4.5-air',
};

export function mapModelIdToVercel(modelId: string, reasoningExplicitlyDisabled: boolean) {
  const hardcodedVercelId = vercelModelIdMapping[modelId];
  if (hardcodedVercelId) {
    if (reasoningExplicitlyDisabled && hardcodedVercelId.endsWith('-reasoning')) {
      return hardcodedVercelId.replace(/-reasoning$/, '-non-reasoning');
    }
    return hardcodedVercelId;
  }

  const internalId =
    kiloExclusiveModels.find(
      m => m.public_id === modelId && m.status !== 'disabled' && m.gateway === 'openrouter'
    )?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) {
    return internalId;
  }

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}
