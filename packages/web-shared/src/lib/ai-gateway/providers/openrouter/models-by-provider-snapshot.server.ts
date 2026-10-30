import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { fetchLatestModelsByProviderSnapshotFromDb } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import type { NormalizedOpenRouterResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

/**
 * Both catalog endpoints (`/api/v1/models-by-provider` and `/api/v1/providers`)
 * serve this snapshot row, so one cache bounds their database reads regardless
 * of request volume.
 */
export const MODELS_BY_PROVIDER_SNAPSHOT_TTL_MS = 600_000;

/**
 * The latest catalog snapshot, or `null` when the table has no row. Shared by
 * both catalog handlers; each one derives its own response body from it.
 *
 * The cached value is the raw snapshot only. A per-caller subset, such as the
 * organization-filtered catalog, must never be written here.
 */
export const getModelsByProviderSnapshot = createCachedFetch<NormalizedOpenRouterResponse | null>(
  async () => {
    const snapshot = await fetchLatestModelsByProviderSnapshotFromDb();
    if (!snapshot) {
      // Throwing is how an absent row stays out of the TTL: `createCachedFetch`
      // reports the refresh, serves the default, and retries after its failure
      // backoff, so a catalog written moments later becomes visible within that
      // window instead of being pinned as `null` for the whole TTL.
      throw new Error('No models_by_provider snapshot row');
    }
    return snapshot;
  },
  MODELS_BY_PROVIDER_SNAPSHOT_TTL_MS,
  null,
  { name: 'modelsByProviderSnapshot' }
);
