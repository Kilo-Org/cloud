import { formatError, ttlCached } from '@kilocode/worker-utils';
import {
  ROUTING_TABLE_KV_KEY,
  RoutingTableSchema,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { kvReadThrough } from './kv-read-through';
import { fetchRoutingTableFromOrigin } from './benchmark-origin';

// Safety net used until the first decider benchmark publishes a table (and
// whenever the stored table is missing or unparseable). Mirrors the static
// defaults the gateway uses for kilo-auto/balanced today.
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  version: 'default',
  generatedAt: '2026-06-11T00:00:00.000Z',
  minAccuracy: 0.7,
  source: 'default',
  tiers: {
    low: [
      {
        model: 'google/gemini-2.5-flash',
        accuracy: 1,
        avgCostUsd: 0,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions'],
      },
    ],
    medium: [
      {
        model: 'qwen/qwen3.7-plus',
        accuracy: 1,
        avgCostUsd: 0,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions'],
      },
      {
        model: 'anthropic/claude-sonnet-4.6',
        accuracy: 1,
        avgCostUsd: 0,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions', 'messages', 'responses'],
      },
    ],
    high: [
      {
        model: 'anthropic/claude-sonnet-4.6',
        accuracy: 1,
        avgCostUsd: 0,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions', 'messages', 'responses'],
      },
    ],
  },
};

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
  return table ?? DEFAULT_ROUTING_TABLE;
});

export function clearRoutingTableCache(): void {
  routingTableCache.clear();
}

export function getRoutingTable(env: RoutingTableEnv): Promise<RoutingTable> {
  return routingTableCache.get(env).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'auto_routing_table_read_failed', ...formatError(error) })
    );
    return DEFAULT_ROUTING_TABLE;
  });
}
