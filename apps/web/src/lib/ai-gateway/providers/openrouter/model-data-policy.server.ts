import 'server-only';
import { createCachedFetch } from '@/lib/cached-fetch';
import {
  buildModelDataPolicies,
  type ModelDataPolicy,
} from '@/lib/ai-gateway/providers/openrouter/model-data-policy';
import {
  fetchLatestModelsByProviderSnapshotFromDb,
  getSnapshotModelVariantId,
} from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

export type { ModelDataPolicy } from '@/lib/ai-gateway/providers/openrouter/model-data-policy';

export const getModelDataPolicies = createCachedFetch<
  ReadonlyMap<string, readonly ModelDataPolicy[]>
>(
  async () =>
    buildModelDataPolicies(
      await fetchLatestModelsByProviderSnapshotFromDb(),
      getSnapshotModelVariantId
    ),
  30_000,
  new Map()
);
