import type { RouteRecord } from './routes.js';

type RenewalRoute = Pick<RouteRecord, 'sessionId' | 'state' | 'grant'>;

/**
 * Retry times are keyed by the grant's scope, so the members of a shared worktree
 * scope share one renewal attempt and one retry instead of one each.
 */
export type CredentialRenewalRetries = Map<string, number>;

/**
 * When the alarm should next renew a ready route's credential grant: once it
 * enters the re-issue window, and after a failed attempt at its retry time or
 * at expiry, whichever is first, so an unrenewable grant fails its route on time.
 * Renewal keeps the sandbox-visible handle and aliases, so a running Kilo keeps
 * working without a restart; only the server-side lease and backing tokens move.
 */
export function credentialRenewalDueAt(
  route: RenewalRoute,
  reissueBelowMs: number,
  retries: ReadonlyMap<string, number>
): number | null {
  if (route.state !== 'ready' || route.grant === null) return null;
  const windowAt = route.grant.expiresAt - reissueBelowMs;
  const retryAt = retries.get(route.grant.scopeId);
  if (retryAt === undefined) return windowAt;
  return Math.max(windowAt, Math.min(retryAt, route.grant.expiresAt));
}

export function nextCredentialRenewalAt(
  routes: readonly RenewalRoute[],
  reissueBelowMs: number,
  retries: ReadonlyMap<string, number>
): number | null {
  let next: number | null = null;
  for (const route of routes) {
    const at = credentialRenewalDueAt(route, reissueBelowMs, retries);
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

/** Drops retry times for scopes that no longer have a ready route. */
export function pruneCredentialRenewalRetries(
  retries: CredentialRenewalRetries,
  routes: readonly RenewalRoute[]
): void {
  const ready = new Set(
    routes.flatMap(route => (route.state === 'ready' && route.grant ? [route.grant.scopeId] : []))
  );
  for (const scopeId of retries.keys()) if (!ready.has(scopeId)) retries.delete(scopeId);
}
