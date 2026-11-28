import { formatError, ttlCached } from '@kilocode/worker-utils';
import {
  DEFAULT_AUTO_ROUTER,
  routingTableKvKey,
  RoutingTableSchema,
  type RoutingTable,
  type AutoRouter,
} from '@kilocode/auto-routing-contracts';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { kvReadThrough } from './kv-read-through';
import { fetchRoutingTableFromOrigin, type BenchmarkEnv } from './benchmark-origin';

const ROUTING_TABLE_CACHE_TTL_MS = 60_000;

type RoutingTableEnv = Pick<Env, 'AUTO_ROUTING_CONFIG'> & BenchmarkEnv;

/** The cache loader's input: the env and the invocation that triggered the load. */
type RoutingTableLoad = { env: RoutingTableEnv; ctx?: SecretsExecutionContext };

function createRoutingTableCache(router: AutoRouter) {
  return ttlCached(ROUTING_TABLE_CACHE_TTL_MS, async ({ env, ctx }: RoutingTableLoad) => {
    const table = await kvReadThrough({
      kv: env.AUTO_ROUTING_CONFIG,
      key: routingTableKvKey(router),
      ttlSeconds: 3600,
      fetchOrigin: () => fetchRoutingTableFromOrigin(env, router, ctx),
      parse: raw => {
        try {
          const parsed = RoutingTableSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) {
            console.warn(
              JSON.stringify({
                event: 'auto_routing_table_invalid',
                issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.code}`),
              })
            );
            return null;
          }
          return parsed.data;
        } catch (error) {
          console.warn(
            JSON.stringify({ event: 'auto_routing_table_invalid', ...formatError(error) })
          );
          return null;
        }
      },
    });
    return table;
  });
}

const routingTableCaches = {
  efficient: createRoutingTableCache('efficient'),
  frontier: createRoutingTableCache('frontier'),
};

export function clearRoutingTableCache(): void {
  for (const cache of Object.values(routingTableCaches)) cache.clear();
}

/**
 * `ctx` is the invocation reading the table: an origin load it triggers runs its token renewal
 * under the invocation's `waitUntil`.
 */
export function getRoutingTable(
  env: RoutingTableEnv,
  router: AutoRouter = DEFAULT_AUTO_ROUTER,
  ctx?: SecretsExecutionContext
): Promise<RoutingTable | null> {
  const cache = routingTableCaches[router];
  return cache.get({ env, ctx }).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'auto_routing_table_read_failed', ...formatError(error) })
    );
    return null;
  });
}
