import { formatError, ttlCached } from '@kilocode/worker-utils';
import {
  ROUTING_TABLE_KV_KEY,
  RoutingTableSchema,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { kvReadThrough } from './kv-read-through';
import { fetchRoutingTableFromOrigin } from './benchmark-origin';

const ROUTING_TABLE_CACHE_TTL_MS = 60_000;

type RoutingTableEnv = Pick<
  Env,
  'AUTO_ROUTING_CONFIG' | 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'
>;

const routingTableCache = ttlCached(ROUTING_TABLE_CACHE_TTL_MS, async (env: RoutingTableEnv) => {
  const table = await kvReadThrough({
    kv: env.AUTO_ROUTING_CONFIG,
    key: ROUTING_TABLE_KV_KEY,
    ttlSeconds: 3600,
    fetchOrigin: () => fetchRoutingTableFromOrigin(env),
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

export function clearRoutingTableCache(): void {
  routingTableCache.clear();
}

// Null when no benchmark-published table exists (or it cannot be read):
// /decide then makes no decision and the gateway falls back to its static
// balanced defaults.
export function getRoutingTable(env: RoutingTableEnv): Promise<RoutingTable | null> {
  return routingTableCache.get(env).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'auto_routing_table_read_failed', ...formatError(error) })
    );
    return null;
  });
}
