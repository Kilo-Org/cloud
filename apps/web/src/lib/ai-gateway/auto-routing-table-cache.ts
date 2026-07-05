import { getBenchmarkRoutingTable } from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { createCachedFetch } from '@/lib/cached-fetch';

const ROUTING_TABLE_TTL_MS = 5 * 60 * 1000;

/**
 * Cache the benchmark routing table in-process. It is fetched on every model
 * listing (org endpoint and the tRPC settings query), so an uncached admin-worker
 * round-trip per request is wasteful. `createCachedFetch` also serves the
 * last-known-good table when a refresh throws, so a transient worker outage does
 * not blank the Auto Efficient choices shown in the UI.
 */
export const getCachedRoutingTable = createCachedFetch(
  async () => {
    const result = await getBenchmarkRoutingTable();
    if (result.status === 200 && 'table' in result.body) {
      // `table` may be null, meaning no routing is configured — a valid state to cache.
      return result.body.table;
    }
    throw new Error(`benchmark routing table unavailable (status ${result.status})`);
  },
  ROUTING_TABLE_TTL_MS,
  null
);
