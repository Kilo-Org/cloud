import 'server-only';

import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { getRawOpenRouterModels } from './openrouter';

const TTL_MS = 60_000;

/**
 * The provider's raw model catalog, which carries the prices and the completion
 * ceiling admission bounds a request with. The underlying fetch is also cached
 * by Next; this cache keeps an expired entry from costing one fetch per request
 * and holds the last good catalog through an outage.
 */
export const getRawModelCatalog = createCachedFetch<OpenRouterModel[]>(
  async () => (await getRawOpenRouterModels()).data,
  TTL_MS,
  [],
  { name: 'rawModelCatalog' }
);
