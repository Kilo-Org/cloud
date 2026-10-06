/**
 * Dev-only hold for the glanceable fixture harness (`fixture-harness.ts`).
 * While a fixture is on the surfaces the live publisher must not overwrite it,
 * so `GlanceablePublisher.isGated` reads this flag. Only the harness sets it,
 * and the harness is reachable only behind `__DEV__`; in a release build the
 * flag stays false and the publisher behaves exactly as before.
 *
 * Release bumps a counter the publisher mount subscribes to: it rebuilds its
 * publisher, seeded from the persisted fixture snapshot, so the first live
 * write goes through with a higher revision than the fixture's and every sink
 * accepts it.
 */

let held = false;
let releases = 0;
const listeners = new Set<() => void>();

export function isGlanceableFixtureHeld(): boolean {
  return held;
}

export function holdGlanceableFixture(): void {
  held = true;
}

export function releaseGlanceableFixtureHold(): void {
  if (!held) {
    return;
  }
  held = false;
  releases += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** How many holds were released; for `useSyncExternalStore`. */
export function getGlanceableFixtureReleases(): number {
  return releases;
}

export function subscribeGlanceableFixtureReleases(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
