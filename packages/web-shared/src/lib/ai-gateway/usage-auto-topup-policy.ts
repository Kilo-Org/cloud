import { BENCHMARK_PROJECT_PREFIX } from '@kilocode/auto-routing-contracts';

/**
 * Whether the native usage writer may start an automatic top-up for this row.
 *
 * A benchmark case never initiates a purchase on its payer's behalf, and the reserved project
 * prefix is only writable by the authenticated benchmark assignment: the gateway strips it from
 * a caller-supplied `X-KiloCode-ProjectId`. A malformed value under the prefix still means the
 * row came from the benchmark path, so this matches the prefix rather than parsing the id.
 */
export function usageMayAutoTopUp(usage: { cost: number; project_id: string | null }): boolean {
  if (usage.cost <= 0) return false;
  return !usage.project_id?.startsWith(`${BENCHMARK_PROJECT_PREFIX} `);
}
