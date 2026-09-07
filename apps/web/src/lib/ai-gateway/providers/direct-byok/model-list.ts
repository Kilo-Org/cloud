import {
  DirectByokModelArraySchema,
  type DirectByokModel,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { createCachedFetch } from '@/lib/cached-fetch';
import { readDb } from '@/lib/drizzle';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

type CachedEnhancedModelListOptions = {
  providerId: DirectUserByokInferenceProviderId;
  recommendedModels: ReadonlyArray<DirectByokModel>;
};

export function cachedEnhancedDirectByokModelList({
  providerId,
  recommendedModels,
}: CachedEnhancedModelListOptions) {
  return createCachedFetch<ReadonlyArray<DirectByokModel>>(
    async () => {
      const [row] = await readDb
        .select({ models: direct_byok_model_lists.models })
        .from(direct_byok_model_lists)
        .where(eq(direct_byok_model_lists.provider_id, providerId))
        .limit(1);
      return enhanceDirectByokModelList({
        recommendedModels,
        remainingModels: DirectByokModelArraySchema.parse(row ? row.models : []),
      });
    },
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
