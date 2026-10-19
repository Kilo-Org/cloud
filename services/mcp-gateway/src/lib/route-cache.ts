import type { ScopedConnectRoute } from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';
import { resolveActiveRoute } from '../db/runtime-repository';

export const ROUTE_CACHE_TTL_MS = 5_000;
export const ROUTE_CACHE_MAX_ENTRIES = 1_000;

export type CachedRouteEntry = { connectResourceId: string | null; expiresAtMs: number };

export type RouteCacheStore = Map<string, CachedRouteEntry>;

const store: RouteCacheStore = new Map();

export type CachedRouteResolution = { connect_resource_id: string } | null;

export function routeCacheKey(route: ScopedConnectRoute): string {
  return `${route.ownerScope}:${route.ownerId}:${route.configId}:${route.routeKey}`;
}

function readEntry(route: ScopedConnectRoute, nowMs: number): CachedRouteEntry | null {
  const key = routeCacheKey(route);
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    store.delete(key);
    return null;
  }
  return entry;
}

function writeEntry(
  route: ScopedConnectRoute,
  connectResourceId: string | null,
  nowMs: number
): void {
  const key = routeCacheKey(route);
  if (store.size >= ROUTE_CACHE_MAX_ENTRIES && !store.has(key)) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(key, { connectResourceId, expiresAtMs: nowMs + ROUTE_CACHE_TTL_MS });
}

/**
 * Resolves whether a scoped route is active through a short-lived in-isolate
 * cache so repeated requests for the same route — including known-missing
 * routes — do not each run a Postgres lookup. The cached value covers only the
 * route/config existence check; runtime eligibility state is always re-read
 * from Postgres for authenticated requests.
 */
export async function resolveActiveRouteCached(params: {
  env: MCPGatewayEnv['Bindings'];
  route: ScopedConnectRoute;
  nowMs?: number;
}): Promise<CachedRouteResolution> {
  const nowMs = params.nowMs ?? Date.now();
  const entry = readEntry(params.route, nowMs);
  if (entry) {
    return entry.connectResourceId === null ? null : { connect_resource_id: entry.connectResourceId };
  }
  const resolved = await resolveActiveRoute({ env: params.env, route: params.route });
  writeEntry(params.route, resolved ? resolved.route.connect_resource_id : null, nowMs);
  return resolved ? { connect_resource_id: resolved.route.connect_resource_id } : null;
}

/** Test hook: clear all cached route entries. */
export function clearRouteCacheForTests(): void {
  store.clear();
}
