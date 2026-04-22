import { isFreeModel, kiloExclusiveModels, preferredModels } from '@/lib/ai-gateway/models';
import { KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';

const MAX_SUGGESTIONS = 3;

async function getOpenRouterModelIds(): Promise<Set<string>> {
  try {
    const raw = await redisGet(GATEWAY_METADATA_REDIS_KEYS.openrouterModels);
    if (!raw) return new Set();
    return new Set(Object.keys(JSON.parse(raw) as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

function isKiloExclusiveAvailable(modelId: string): boolean {
  return kiloExclusiveModels.some(m => m.public_id === modelId && m.status !== 'disabled');
}

export async function getSuggestedFreeModels(): Promise<string[]> {
  const openrouterModelIds = await getOpenRouterModelIds();

  return preferredModels
    .filter(modelId => {
      if (modelId === KILO_AUTO_FREE_MODEL.id) return false;
      if (!isFreeModel(modelId)) return false;
      return isKiloExclusiveAvailable(modelId) || openrouterModelIds.has(modelId);
    })
    .slice(0, MAX_SUGGESTIONS);
}
