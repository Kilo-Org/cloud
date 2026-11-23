import * as z from 'zod';

/**
 * The project namespace reserved for benchmark inference. `microdollar_usage.project_id` of
 * a benchmark case request starts with this prefix, so an ordinary caller must never be able
 * to write it: the gateway strips a caller-supplied project id under this prefix and only the
 * authenticated benchmark assignment writes one.
 *
 * A pool-funded id is exactly `${prefix} / ${scope}/${slug}/${routerId}`: scope, saved-pool
 * slug and router UUID are all the pool table needs to group a row back to its pool and
 * concrete model, and it carries no owner identifier.
 *
 * The platform has no saved pool, so it uses the one reserved value
 * {@link BENCHMARK_PLATFORM_PROJECT_ID}. It is never a pool id, so the user-visible pool view
 * (which parses the scope form) never renders a platform row as a user's pool.
 */
export const BENCHMARK_PROJECT_PREFIX = 'Auto-routing benchmarks';

/** The saved-pool slug grammar, so every prefixed id round-trips through the parser. */
export const BENCHMARK_PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const BENCHMARK_PLATFORM_PROJECT_ID = `${BENCHMARK_PROJECT_PREFIX} / platform`;

/** A pool id: the only form that names a saved user or organization pool. */
export type BenchmarkProjectRef = {
  scope: 'user' | 'org';
  slug: string;
  routerId: string;
};

export const BenchmarkProjectIdSchema = z
  .string()
  .max(256)
  .refine(value => isBenchmarkProjectId(value), { message: 'Not a benchmark project id' });

/** Throws instead of emitting an id the parser would reject. */
export function benchmarkProjectId(ref: BenchmarkProjectRef): string {
  if (ref.scope !== 'user' && ref.scope !== 'org') {
    throw new Error(`invalid benchmark project scope: ${String(ref.scope)}`);
  }
  if (!BENCHMARK_PROJECT_SLUG_PATTERN.test(ref.slug)) {
    throw new Error(`invalid benchmark project slug: ${ref.slug}`);
  }
  if (!z.uuid().safeParse(ref.routerId).success) {
    throw new Error(`invalid benchmark project router id: ${ref.routerId}`);
  }
  return `${BENCHMARK_PROJECT_PREFIX} / ${ref.scope}/${ref.slug}/${ref.routerId}`;
}

/**
 * The only way to read a pool project id. A bare `startsWith` check would accept
 * `Auto-routing benchmarks / junk`; this returns null unless scope, slug and UUID are exact.
 * The platform value also returns null, so a caller that renders pools never sees it.
 */
export function parseBenchmarkProjectId(
  value: string | null | undefined
): BenchmarkProjectRef | null {
  if (!value || value.length > 256) return null;
  const prefix = `${BENCHMARK_PROJECT_PREFIX} / `;
  if (!value.startsWith(prefix)) return null;
  const match = /^(user|org)\/([^/]+)\/([^/]+)$/.exec(value.slice(prefix.length));
  if (!match) return null;
  const [, scope, slug, routerId] = match;
  if (scope !== 'user' && scope !== 'org') return null;
  if (!BENCHMARK_PROJECT_SLUG_PATTERN.test(slug)) return null;
  if (!z.uuid().safeParse(routerId).success) return null;
  return { scope, slug, routerId };
}

/** True for any reserved benchmark project id: a pool id or the platform value. */
export function isBenchmarkProjectId(value: string | null | undefined): boolean {
  return value === BENCHMARK_PLATFORM_PROJECT_ID || parseBenchmarkProjectId(value) !== null;
}
