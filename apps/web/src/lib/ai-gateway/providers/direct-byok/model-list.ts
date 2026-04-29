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
  models,
  addFlags,
  getVariants,
}: {
  models: ReadonlyArray<DirectByokModel>;
  addFlags: (model: DirectByokModel) => ReadonlyArray<string>;
  getVariants: (model: DirectByokModel) => Record<string, OpenCodeVariant>;
}) {
  const seenIds = new Set<string>();
  return models
    .filter(model => (seenIds.has(model.id) ? false : (seenIds.add(model.id), true)))
    .map(model => ({
      ...model,
      flags: [...new Set([...model.flags, ...addFlags(model)])],
      variants: getVariants(model),
    }));
}
