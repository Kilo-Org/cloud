/**
 * Read-only route lifecycle signal: the current settled visible leaf route.
 *
 * `use-screen-tracking` publishes the leaf once navigation is not stale and
 * the segments stayed stable for the settle window. Consumers (W3-C's
 * accessibility/focus work and analytics) read the same value through
 * `getSettledLeafRoute()` / `subscribeSettledLeafRoute()`.
 *
 * This module has no focus or accessibility behavior of its own — it only
 * exposes the shared signal.
 */

let settledLeafRoute: string | null = null;

const listeners = new Set<() => void>();

/** The current settled leaf route, or null before the first route settles. */
export function getSettledLeafRoute(): string | null {
  return settledLeafRoute;
}

/** Subscribe to changes of the settled leaf route. Returns an unsubscribe. */
export function subscribeSettledLeafRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish a settled leaf. No-op when the value is unchanged. */
export function publishSettledLeafRoute(leaf: string): void {
  if (leaf === settledLeafRoute) {
    return;
  }
  settledLeafRoute = leaf;
  for (const listener of listeners) {
    listener();
  }
}

/** Reset the signal. For tests only. */
export function resetSettledLeafRouteForTests(): void {
  settledLeafRoute = null;
}
