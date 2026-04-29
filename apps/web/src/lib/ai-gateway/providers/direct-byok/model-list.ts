import {
  DirectByokModelArraySchema,
  type DirectByokModel,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { createCachedFetch } from '@/lib/cached-fetch';
import { redisGet } from '@/lib/redis';
import { directByokModelsRedisKey } from '@/lib/redis-keys';
import type { OpenCodeVariant } from '@kilocode/db/schema-types';

export function cacheDirectByokModelList(providerId: DirectUserByokInferenceProviderId) {
  return createCachedFetch(
    async () =>
      DirectByokModelArraySchema.parse(
        JSON.parse((await redisGet(directByokModelsRedisKey(providerId))) ?? '[]')
      ),
    60_000,
    []
  );
}

export function enhanceDirectByokModelList({
  recommendedModels,
  remainingModels,
  variants,
}: {
  recommendedModels: ReadonlyArray<DirectByokModel>;
  remainingModels: ReadonlyArray<DirectByokModel>;
  variants: Record<string, OpenCodeVariant> | null;
}): ReadonlyArray<DirectByokModel> {
  const seenIds = new Set<string>();
  return [...recommendedModels, ...remainingModels]
    .filter(model => (seenIds.has(model.id) ? false : (seenIds.add(model.id), true)))
    .map(model => {
      const flags = new Set(model.flags);
      if (recommendedModels.some(m => m.id === model.id)) flags.add('recommended');
      return {
        ...model,
        flags: [...flags],
        variants: model.variants ?? variants,
      };
    });
}
