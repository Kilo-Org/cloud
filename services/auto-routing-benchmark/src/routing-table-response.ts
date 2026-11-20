import type { AutoRouter, RoutingTable } from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { getLatestRoutingTable } from './db';

type RoutingTableResponseEnv = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'BENCH_DB'>;

/** KV key for the serialized GET /admin/routing-table body of one router. */
export function routingTableResponseKvKey(router: AutoRouter): string {
  return `benchmark_routing_table_response_v1:${router}`;
}

/** KV key naming the publication a cached body must match before it is served. */
export function routingTableVersionKvKey(router: AutoRouter): string {
  return `benchmark_routing_table_version_v1:${router}`;
}

/** A re-save of an unchanged version still moves `publishedAt`, which the body carries. */
function publicationToken(latest: { table: RoutingTable; publishedAt: string }): string {
  return `${latest.table.version} ${latest.publishedAt}`;
}

/**
 * KV's minimum edge cache time. It bounds how long a location keeps serving the previous
 * publication's body after the pointer moves.
 */
const VERSION_POINTER_CACHE_TTL_SECONDS = 30;
const POINTER_SYNC_ATTEMPTS = 5;

/**
 * Point readers at the latest publication in D1. Called by every publish after its D1
 * write; a concurrent publish that wrote an older pointer is corrected by re-reading
 * until the pointer matches what D1 holds.
 */
export async function syncRoutingTableVersionPointer(
  env: RoutingTableResponseEnv,
  router: AutoRouter
): Promise<void> {
  const key = routingTableVersionKvKey(router);
  let latest = await getLatestRoutingTable(env.BENCH_DB, router);
  for (let attempt = 0; attempt < POINTER_SYNC_ATTEMPTS; attempt++) {
    const token = latest ? publicationToken(latest) : null;
    if (token === null) await env.AUTO_ROUTING_CONFIG.delete(key);
    else await env.AUTO_ROUTING_CONFIG.put(key, token);
    latest = await getLatestRoutingTable(env.BENCH_DB, router);
    if ((latest ? publicationToken(latest) : null) === token) return;
  }
  await env.AUTO_ROUTING_CONFIG.delete(key);
}

async function readCache(env: RoutingTableResponseEnv, router: AutoRouter) {
  try {
    const [pointer, cached] = await Promise.all([
      env.AUTO_ROUTING_CONFIG.get(routingTableVersionKvKey(router), {
        cacheTtl: VERSION_POINTER_CACHE_TTL_SECONDS,
      }),
      env.AUTO_ROUTING_CONFIG.getWithMetadata<{ token: string }>(routingTableResponseKvKey(router)),
    ]);
    return { pointer, body: cached.value, token: cached.metadata?.token ?? null };
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'routing_table_response_cache_read_failed', ...formatError(error) })
    );
    return { pointer: null, body: null, token: null };
  }
}

/**
 * The serialized `{ table, publishedAt }` body for one router. A cached body is served
 * only when it belongs to the publication the pointer names, and a body read from D1 is
 * cached only when it is that publication, so a read that raced a publish can store an
 * older body but never make it servable.
 */
export async function loadRoutingTableResponse(
  env: RoutingTableResponseEnv,
  router: AutoRouter
): Promise<string> {
  const cache = await readCache(env, router);
  if (cache.pointer !== null && cache.body !== null && cache.token === cache.pointer) {
    return cache.body;
  }

  const latest = await getLatestRoutingTable(env.BENCH_DB, router);
  const body = JSON.stringify({
    table: latest?.table ?? null,
    publishedAt: latest?.publishedAt ?? null,
  });
  const token = latest ? publicationToken(latest) : null;
  if (token !== null && token === cache.pointer) {
    try {
      await env.AUTO_ROUTING_CONFIG.put(routingTableResponseKvKey(router), body, {
        metadata: { token },
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'routing_table_response_cache_write_failed',
          ...formatError(error),
        })
      );
    }
  }
  return body;
}
