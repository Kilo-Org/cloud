import { DEFAULT_AUTO_ROUTER, type AutoRouter } from '@kilocode/auto-routing-contracts';
import { getBenchmarkRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';

const ROUTING_TABLE_TTL_MS = 5 * 60 * 1000;

function createCachedRoutingTable(router: AutoRouter) {
  return createCachedFetch(
    async () => {
      const result = await getBenchmarkRoutingTable(router);
      if (result.status === 200 && 'table' in result.body) {
        // `table` may be null, meaning no routing is configured — a valid state to cache.
        return result.body.table;
      }
      throw new Error(
        `benchmark routing table unavailable for ${router} (status ${result.status})`
      );
    },
    ROUTING_TABLE_TTL_MS,
    null
  );
}

/**
 * Cache each router's benchmark routing table in-process. It is fetched on every
 * model listing and auto-routed request, so an uncached admin-worker round-trip
 * per request is wasteful. `createCachedFetch` also serves the last-known-good
 * table when a refresh throws, so a transient worker outage does not blank the
 * auto choices shown in the UI.
 */
const cachedRoutingTables = {
  efficient: createCachedRoutingTable('efficient'),
  frontier: createCachedRoutingTable('frontier'),
};

export function getCachedRoutingTable(router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return cachedRoutingTables[router]();
}
