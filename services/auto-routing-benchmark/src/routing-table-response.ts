import { BenchmarkRoutingTableResponseSchema, type AutoRouter } from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { getLatestRoutingTable } from './db';

type RoutingTableResponseEnv = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'BENCH_DB'>;

/**
 * Publishing deletes the key; the expiry bounds a read that loaded the previous table
 * from D1 and wrote it back after that delete.
 */
const ROUTING_TABLE_RESPONSE_TTL_SECONDS = 300;

/** KV key for the serialized GET /admin/routing-table body of one router. */
export function routingTableResponseKvKey(router: AutoRouter): string {
  return `benchmark_routing_table_response_v1:${router}`;
}

function isRoutingTableResponse(raw: string): boolean {
  try {
    return BenchmarkRoutingTableResponseSchema.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}

/**
 * The serialized `{ table, publishedAt }` body for one router. Web instances refresh it
 * every few minutes each, so it is served from KV and D1 is read only on a miss.
 */
export async function loadRoutingTableResponse(
  env: RoutingTableResponseEnv,
  router: AutoRouter
): Promise<string> {
  const key = routingTableResponseKvKey(router);
  let cached: string | null = null;
  try {
    cached = await env.AUTO_ROUTING_CONFIG.get(key);
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'routing_table_response_cache_read_failed', ...formatError(error) })
    );
  }
  if (cached !== null && isRoutingTableResponse(cached)) return cached;

  const latest = await getLatestRoutingTable(env.BENCH_DB, router);
  const body = JSON.stringify({
    table: latest?.table ?? null,
    publishedAt: latest?.publishedAt ?? null,
  });
  try {
    await env.AUTO_ROUTING_CONFIG.put(key, body, {
      expirationTtl: ROUTING_TABLE_RESPONSE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'routing_table_response_cache_write_failed', ...formatError(error) })
    );
  }
  return body;
}
