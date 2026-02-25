import { kiloFreeModels } from '@/lib/models';
import { inferVercelFirstPartyInferenceProviderForModel } from '@/lib/providers/openrouter/inference-provider-id';

const vercelModelIdMapping: Record<string, string | undefined> = {
  'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
};

export function mapModelIdToVercel(modelId: string) {
  const hardcodedVercelId = vercelModelIdMapping[modelId];
  if (hardcodedVercelId) {
    return hardcodedVercelId;
  }

  const internalId =
    kiloFreeModels.find(m => m.public_id === modelId && m.is_enabled && m.gateway === 'openrouter')
      ?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) {
    return internalId;
  }

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}
