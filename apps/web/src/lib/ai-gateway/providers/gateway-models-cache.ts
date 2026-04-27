import { StoredModelSchema } from '@kilocode/db';
import * as z from 'zod';
import { redisGet } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';
import type { RedisKey } from '@/lib/redis-keys';

function createGatewayModelsFetcher(redisKey: RedisKey, name: string) {
  return createCachedFetch(
    async function () {
      const result = JSON.parse((await redisGet(redisKey)) ?? 'null');
      if (Object.keys(result).length === 0) {
        console.debug(`[getGatewayModels] no ${name} models found in Redis`);
      }
      return new Set(
        Object.values(z.record(z.string(), StoredModelSchema).parse(result))
          .filter(model => (model.type ?? 'language') === 'language' && model.endpoints.length > 0)
          .map(model => model.id)
      );
    },
    60_000,
    new Set<string>()
  );
}

export const getOpenRouterModels = createGatewayModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.openrouterModels,
  'OpenRouter'
);

export const getVercelModels = createGatewayModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.vercelModels,
  'Vercel'
);
