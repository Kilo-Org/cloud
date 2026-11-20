import type { AutoRouter } from '@kilocode/auto-routing-contracts';

/**
 * The KV keys that name one router's cached admin reads.
 *
 * They live apart from any reader so the routing-table response cache and the
 * probe-eligibility cache can share the publication pointer without importing each other:
 * a publish stamps both, and either reader has to be able to name the other's key.
 */
export function routingTableResponseKvKey(router: AutoRouter): string {
  return `benchmark_routing_table_response_v1:${router}`;
}

/** Names the publication a cached body (and the eligibility answer) must match. */
export function routingTableVersionKvKey(router: AutoRouter): string {
  return `benchmark_routing_table_version_v1:${router}`;
}

/** One key per router: the answer is that router's eligibility set, not a pair's. */
export function probeEligibilityKvKey(router: AutoRouter): string {
  return `benchmark_probe_eligibility_v1:${router}`;
}
