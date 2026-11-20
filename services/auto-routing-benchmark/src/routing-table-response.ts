import type { AutoRouter, RoutingTable } from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { getLatestRoutingTable } from './db';
import {
  probeEligibilityKvKey,
  routingTableResponseKvKey,
  routingTableVersionKvKey,
} from './routing-table-cache-keys';

type RoutingTableResponseEnv = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'BENCH_DB'>;

export { routingTableResponseKvKey, routingTableVersionKvKey } from './routing-table-cache-keys';

type LatestRoutingTable = { table: RoutingTable; publishedAt: string } | null;

/** A re-save of an unchanged version still moves `publishedAt`, which the body carries. */
function publicationToken(latest: LatestRoutingTable): string | null {
  return latest ? `${latest.table.version} ${latest.publishedAt}` : null;
}

/**
 * KV's minimum edge cache time (30 s since January 2026). It bounds how long a location
 * keeps reading the previous pointer after a write elsewhere.
 */
const VERSION_POINTER_CACHE_TTL_SECONDS = 30;
/**
 * The cached body expires on its own (KV's `expirationTtl` minimum is 60 s), so a body
 * left unservable by a failed pointer write and a failed recovery delete still goes away.
 */
const RESPONSE_BODY_TTL_SECONDS = 600;
const POINTER_SYNC_ATTEMPTS = 5;

/**
 * Write the pointer for `latest`, then re-read D1 and rewrite it until both agree. Every
 * writer re-reads after its own write, so whichever write lands last is checked against
 * D1 after it, and an older pointer written by a racing reader or publish is replaced.
 * Returns the token the pointer was confirmed at.
 */
async function confirmPointer(
  env: RoutingTableResponseEnv,
  router: AutoRouter,
  latest: LatestRoutingTable
): Promise<string | null> {
  const key = routingTableVersionKvKey(router);
  let token = publicationToken(latest);
  for (let attempt = 0; attempt < POINTER_SYNC_ATTEMPTS; attempt++) {
    if (token === null) await env.AUTO_ROUTING_CONFIG.delete(key);
    else await env.AUTO_ROUTING_CONFIG.put(key, token);
    const current = publicationToken(await getLatestRoutingTable(env.BENCH_DB, router));
    if (current === token) return token;
    token = current;
  }
  await env.AUTO_ROUTING_CONFIG.delete(key);
  throw new Error('routing table version pointer did not settle');
}

/**
 * Point readers at the latest publication in D1; every publish calls it after its D1
 * write. A failure is logged rather than thrown, so the publish still flushes the
 * gateway key. The cached body is then deleted, because the pointer may still name it;
 * the next read finds no body, reads D1 and repairs the pointer.
 *
 * The publication also decides the probe-eligibility answer. That answer is stamped with the
 * pointer, so moving the pointer is what invalidates it: an entry written for the previous
 * publication can never be served. The entry is then deleted as well, so a reader cannot
 * keep re-scanning against a superseded key — done after the pointer write, because the
 * pointer is the authority and a failed delete must not affect it.
 */
export async function syncRoutingTableVersionPointer(
  env: RoutingTableResponseEnv,
  router: AutoRouter
): Promise<void> {
  try {
    await confirmPointer(env, router, await getLatestRoutingTable(env.BENCH_DB, router));
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'routing_table_version_pointer_failed',
        router,
        ...formatError(error),
      })
    );
    await env.AUTO_ROUTING_CONFIG.delete(routingTableResponseKvKey(router)).catch(
      (deleteError: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'routing_table_response_cache_delete_failed',
            router,
            ...formatError(deleteError),
          })
        );
      }
    );
  }
  await deleteProbeEligibilityCache(env, router);
}

async function deleteProbeEligibilityCache(
  env: RoutingTableResponseEnv,
  router: AutoRouter
): Promise<void> {
  try {
    await env.AUTO_ROUTING_CONFIG.delete(probeEligibilityKvKey(router));
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'probe_eligibility_cache_delete_failed',
        router,
        ...formatError(error),
      })
    );
  }
}

type CacheRead =
  | { available: true; pointer: string | null; body: string | null; token: string | null }
  | { available: false };

async function readCache(env: RoutingTableResponseEnv, router: AutoRouter): Promise<CacheRead> {
  try {
    const [pointer, cached] = await Promise.all([
      env.AUTO_ROUTING_CONFIG.get(routingTableVersionKvKey(router), {
        cacheTtl: VERSION_POINTER_CACHE_TTL_SECONDS,
      }),
      env.AUTO_ROUTING_CONFIG.getWithMetadata<{ token: string }>(routingTableResponseKvKey(router)),
    ]);
    return {
      available: true,
      pointer,
      body: cached.value,
      token: cached.metadata?.token ?? null,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'routing_table_response_cache_read_failed', ...formatError(error) })
    );
    return { available: false };
  }
}

/**
 * The serialized `{ table, publishedAt }` body for one router. A cached body is served
 * only when it belongs to the publication the pointer names. A body read from D1 is
 * cached only once the pointer is confirmed at that publication: a reader that finds the
 * pointer missing or different from D1 repairs it with the same write-then-re-read rule
 * as a publish. A read that raced a publish can therefore store an older body, but never
 * make it servable.
 */
export async function loadRoutingTableResponse(
  env: RoutingTableResponseEnv,
  router: AutoRouter
): Promise<string> {
  const cache = await readCache(env, router);
  if (
    cache.available &&
    cache.pointer !== null &&
    cache.body !== null &&
    cache.token === cache.pointer
  ) {
    return cache.body;
  }

  const latest = await getLatestRoutingTable(env.BENCH_DB, router);
  const body = JSON.stringify({
    table: latest?.table ?? null,
    publishedAt: latest?.publishedAt ?? null,
  });
  if (!cache.available) return body;
  const token = publicationToken(latest);
  try {
    const confirmed = token === cache.pointer ? token : await confirmPointer(env, router, latest);
    if (token !== null && confirmed === token) {
      await env.AUTO_ROUTING_CONFIG.put(routingTableResponseKvKey(router), body, {
        expirationTtl: RESPONSE_BODY_TTL_SECONDS,
        metadata: { token },
      });
    }
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'routing_table_response_cache_write_failed', ...formatError(error) })
    );
  }
  return body;
}
