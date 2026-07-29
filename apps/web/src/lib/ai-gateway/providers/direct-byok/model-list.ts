import {
  DirectByokModelArraySchema,
  type DirectByokModel,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { createCachedFetch } from '@/lib/cached-fetch';
import { redisClient } from '@/lib/redis';
import { directByokModelsRedisKey } from '@/lib/redis-keys';

type CachedEnhancedModelListOptions = {
  providerId: DirectUserByokInferenceProviderId;
  recommendedModels: ReadonlyArray<DirectByokModel>;
};

export function cachedEnhancedDirectByokModelList({
  providerId,
  recommendedModels,
}: CachedEnhancedModelListOptions) {
  return createCachedFetch<ReadonlyArray<DirectByokModel>>(
    async () =>
      enhanceDirectByokModelList({
        recommendedModels,
        remainingModels: DirectByokModelArraySchema.parse(
          JSON.parse((await redisClient.get<string>(directByokModelsRedisKey(providerId))) ?? '[]')
        ),
      }),
    600_000,
    recommendedModels
  );
}

function enhanceDirectByokModelList({
  recommendedModels,
  remainingModels,
}: {
  recommendedModels: ReadonlyArray<DirectByokModel>;
  remainingModels: ReadonlyArray<DirectByokModel>;
}): ReadonlyArray<DirectByokModel> {
  const seenIds = new Set<string>();
  const syncedModels = new Map(remainingModels.map(model => [model.id, model]));
  return [...recommendedModels, ...remainingModels]
    .filter(model => (seenIds.has(model.id) ? false : (seenIds.add(model.id), true)))
    .map(model => {
      const flags = new Set(model.flags);
      if (recommendedModels.some(m => m.id === model.id)) flags.add('recommended');
      return {
        ...model,
        flags: flags.size > 0 ? [...flags] : undefined,
        variants: model.variants ?? syncedModels.get(model.id)?.variants,
      };
    });
}
