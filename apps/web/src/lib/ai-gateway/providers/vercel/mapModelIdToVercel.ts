import { kiloExclusiveModels } from '@/lib/ai-gateway/kilo-exclusive-models';
import { resolveOpenRouterModelAlias } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { inferVercelFirstPartyInferenceProviderForModel } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

const vercelModelIdMapping: Record<string, string | undefined> = {
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
  'qwen/qwen3-14b': 'alibaba/qwen-3-14b',
  'qwen/qwen3-235b-a22b': 'alibaba/qwen-3-235b',
  'qwen/qwen3-30b-a3b': 'alibaba/qwen-3-30b',
  'qwen/qwen3-32b': 'alibaba/qwen-3-32b',
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-5-20260630': 'anthropic/claude-sonnet-5',
  'claude-sonnet-4': 'anthropic/claude-sonnet-4',
  'claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
  'minimax-m2.5': 'minimax/minimax-m2.5',
  'minimax-m3': 'minimax/minimax-m3',
  'minimax/minimax-m2.5-20260211': 'minimax/minimax-m2.5',
  'kimi-k3': 'moonshotai/kimi-k3',
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5.2-codex': 'openai/gpt-5.2-codex',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'step-3.5-flash': 'stepfun/step-3.5-flash',
  'mimo-v2.5': 'xiaomi/mimo-v2.5',
  'glm-5.1': 'zai/glm-5.1',
  'glm-5.2': 'zai/glm-5.2',
};

export function mapResolvedModelIdToVercel(modelId: string) {
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

  if (internalId.startsWith('x-ai/')) {
    return `spacexai${internalId.slice(slashIndex)}`;
  }

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}

export async function mapModelIdToVercel(modelId: string): Promise<string> {
  if (!modelId.startsWith('~')) {
    return mapResolvedModelIdToVercel(modelId);
  }

  return mapResolvedModelIdToVercel(await resolveOpenRouterModelAlias(modelId));
}
