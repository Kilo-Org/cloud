import {
  DirectByokModelArraySchema,
  type DirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import type { DirectUserByokInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export function cachedDirectByokModelList(providerId: DirectUserByokInferenceProviderId) {
  return createCachedFetch<ReadonlyArray<DirectByokModel>>(
    async () => {
      const [row] = await readDb
        .select({ models: direct_byok_model_lists.models })
        .from(direct_byok_model_lists)
        .where(eq(direct_byok_model_lists.provider_id, providerId))
        .limit(1);
      return DirectByokModelArraySchema.parse(row ? row.models : []);
    },
    600_000,
    [],
    { name: `directByokModelList[${providerId}]` }
  );
}
