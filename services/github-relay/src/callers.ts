import { STS_GITHUB_RELAY_MIGRATION_PROXY_READ } from '@kilocode/sts-contracts';

/**
 * Who may use the relay and for what. Each caller has its own URL prefix, its own STS scope, the
 * one workload that scope may name, and the GitHub reads it may make: GET only, each path with the
 * query keys it may carry and the shape of each value. Everything else is refused.
 *
 * Only the migration proxy is enabled. kilobot or security-sync is one more row here, with its own
 * prefix, scope (registered in `STS_SCOPE_REGISTRY` and granted by its STS policy) and paths.
 */

export type Route = {
  /** The route class, the only part of the path the relay logs. */
  name: string;
  path: RegExp;
  query: Readonly<Record<string, RegExp>>;
};

export type Caller = {
  prefix: string;
  scope: string;
  workload: string;
  routes: readonly Route[];
};

const SHA = '[0-9a-f]{40}';
const SHA_VALUE = new RegExp(`^${SHA}$`);
const COUNT = /^[0-9]{1,3}$/;
const MIGRATIONS = 'packages/db/src/migrations';
/** A path segment as the proxy writes it (`encodeURIComponent`); never `.` or `..`. */
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}';
const MIGRATION_PATH = new RegExp(`^${MIGRATIONS}(?:/${SEGMENT}){1,8}$`);

/** The read-only calls of services/migration-proxy/src/github.ts, on Kilo-Org/cloud alone. */
function migrationProxyRoutes(): Route[] {
  const repo = '/repos/Kilo-Org/cloud';
  const route = (name: string, path: string, query: Route['query'] = {}): Route => ({
    name,
    path: new RegExp(`^${repo}${path}$`),
    query,
  });
  return [
    route('compare', `/compare/${SHA}\\.\\.\\.(?:${SHA}|main)`, { per_page: COUNT }),
    route('tree', `/git/trees/${SHA}`),
    route('blob', `/git/blobs/${SHA}`),
    route('commits', '/commits', { sha: SHA_VALUE, path: MIGRATION_PATH, per_page: COUNT }),
    route('commit-pulls', `/commits/${SHA}/pulls`, { per_page: COUNT }),
    route('reviews', '/pulls/[1-9][0-9]{0,9}/reviews', { per_page: COUNT, page: COUNT }),
    route('contents', `/contents/${MIGRATIONS}(?:/${SEGMENT}){1,8}`, { ref: SHA_VALUE }),
  ];
}

export const CALLERS: readonly Caller[] = [
  {
    prefix: '/migration-proxy',
    scope: STS_GITHUB_RELAY_MIGRATION_PROXY_READ.scope,
    workload: 'migration-proxy',
    routes: migrationProxyRoutes(),
  },
];

export type Match =
  | { ok: true; caller: Caller; route: Route; upstreamPath: string }
  | { ok: false; reason: 'unknown_caller' | 'path_not_allowed' | 'query_not_allowed' };

/**
 * The caller and route of a request target, after URL parsing has resolved any dot segments.
 * `upstreamPath` is the GitHub path and query exactly as checked.
 */
export function matchTarget(target: URL, callers: readonly Caller[] = CALLERS): Match {
  const caller = callers.find(
    entry => target.pathname === entry.prefix || target.pathname.startsWith(`${entry.prefix}/`)
  );
  if (caller === undefined) return { ok: false, reason: 'unknown_caller' };
  const path = target.pathname.slice(caller.prefix.length);
  const route = caller.routes.find(entry => entry.path.test(path));
  if (route === undefined) return { ok: false, reason: 'path_not_allowed' };
  const seen = new Set<string>();
  for (const [key, value] of target.searchParams) {
    const shape = Object.hasOwn(route.query, key) ? route.query[key] : undefined;
    if (shape === undefined || seen.has(key) || !shape.test(value)) {
      return { ok: false, reason: 'query_not_allowed' };
    }
    seen.add(key);
  }
  return { ok: true, caller, route, upstreamPath: `${path}${target.search}` };
}
