import type { RouteRecord } from './routes.js';

type RenewalRoute = Pick<RouteRecord, 'sessionId' | 'state' | 'grant'>;

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
  retryAt: number | undefined
): number | null {
  if (route.state !== 'ready' || route.grant === null) return null;
  const windowAt = route.grant.expiresAt - reissueBelowMs;
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
    const at = credentialRenewalDueAt(route, reissueBelowMs, retries.get(route.sessionId));
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

/** Drops retry times for routes that are gone or no longer ready. */
export function pruneCredentialRenewalRetries(
  retries: Map<string, number>,
  routes: readonly RenewalRoute[]
): void {
  const ready = new Set(routes.filter(route => route.state === 'ready').map(r => r.sessionId));
  for (const sessionId of retries.keys()) if (!ready.has(sessionId)) retries.delete(sessionId);
}
