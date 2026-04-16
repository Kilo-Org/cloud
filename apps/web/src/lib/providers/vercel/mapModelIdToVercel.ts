import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { inferVercelFirstPartyInferenceProviderForModel } from '@/lib/providers/openrouter/inference-provider-id';

const vercelModelIdMapping: Record<string, string | undefined> = {
  'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
  'mistralai/mistral-embed-2312': 'mistral/mistral-embed',
  'mistralai/codestral-embed-2505': 'mistral/codestral-embed',
  'x-ai/grok-4-fast': 'xai/grok-4-fast-reasoning',
  'x-ai/grok-4.1-fast': 'xai/grok-4.1-fast-reasoning',
  'x-ai/grok-4.20-beta': 'xai/grok-4.20-reasoning',
  // Mistral date-suffixed → Vercel clean names
  'mistralai/ministral-14b-2512': 'mistral/ministral-14b',
  'mistralai/ministral-3b-2512': 'mistral/ministral-3b',
  'mistralai/ministral-8b-2512': 'mistral/ministral-8b',
  'mistralai/mistral-large-2512': 'mistral/mistral-large-3',
  'mistralai/mistral-medium-3': 'mistral/mistral-medium',
  'mistralai/mistral-medium-3.1': 'mistral/mistral-medium',
  'mistralai/mistral-small-2603': 'mistral/mistral-small',
  'mistralai/pixtral-large-2411': 'mistral/pixtral-large',
  // Qwen name format: qwen3-Xb → qwen-3-Xb
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
      m => m.public_id === modelId && m.status !== 'disabled' && m.gateway === 'openrouter'
    )?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) {
    return internalId;
  }

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}
