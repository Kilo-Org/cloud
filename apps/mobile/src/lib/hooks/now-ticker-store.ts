/**
 * Shared clock store for `useNowTicker`.
 *
 * A ticking clock is external mutable state, so it belongs in a store read via
 * `useSyncExternalStore` rather than one `useState` + `setInterval` per hook
 * consumer. Each interval value gets one lazily created, ref-counted ticker:
 * the first subscriber starts the single timer, later subscribers share the
 * same snapshot, and the last unsubscribe clears the timer and drops the
 * ticker so a later mount starts a fresh timer and a fresh `now`.
 */
// Property signatures (not methods) keep the two references stable and
// `this`-free when handed straight to `useSyncExternalStore`.
export type NowTicker = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
};

type TickerRegistration = {
  ticker: NowTicker;
  stop: () => void;
  hasSubscribers: () => boolean;
  /** When the snapshot was sampled; the registry compares it against `intervalMs`. */
  createdAt: number;
};

const tickers = new Map<number, TickerRegistration>();

function createRegistration(intervalMs: number): TickerRegistration {
  const listeners = new Set<() => void>();
  // Cached snapshot: `getSnapshot` must never call `Date.now()` inline, or
  // `useSyncExternalStore` would see a new value on every render and loop.
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined = undefined;

  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const registration: TickerRegistration = {
    stop,
    hasSubscribers: () => listeners.size > 0,
    createdAt: now,
    // Arrow properties keep both method references stable and `this`-free,
    // which is what `useSyncExternalStore` requires.
    ticker: {
      subscribe: listener => {
        listeners.add(listener);
        if (listeners.size === 1) {
          // `now` is not re-stamped here. The ticker was created inside the
          // render that read `getSnapshot`, so moving the value between that
          // render and this subscription is a change React never saw: it would
          // tear the store and force a second commit on every first mount.
          timer = setInterval(() => {
            now = Date.now();
            for (const current of listeners) {
              current();
            }
          }, intervalMs);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            stop();
            // Only drop the registry entry if it still points at this
            // registration; a reset may already have replaced it.
            if (tickers.get(intervalMs) === registration) {
              tickers.delete(intervalMs);
            }
          }
        };
      },
      getSnapshot: () => now,
    },
  };
  return registration;
}

/**
 * Return the ticker for `intervalMs`, creating it on first use. The returned
 * object and its two methods are stable for as long as the ticker lives, which
 * is what `useSyncExternalStore` requires.
 *
 * A registration with no subscribers that is already older than one interval is
 * a leftover: it was created by a render that React discarded before committing
 * (an interrupted or suspended render, or one replayed after an error) and no
 * cleanup runs for it. Reusing it would serve the instant that discarded render
 * read, so relative labels would sit behind by however long ago it was. It is
 * replaced instead, which keeps the snapshot the committing render reads current.
 * A younger unsubscribed registration is kept, because every component of one
 * commit reads the registry during the same render pass, before any of them
 * subscribes; replacing it there would hand two components two different tickers.
 */
export function getNowTicker(intervalMs: number): NowTicker {
  const existing = tickers.get(intervalMs);
  if (existing && (existing.hasSubscribers() || Date.now() - existing.createdAt < intervalMs)) {
    return existing.ticker;
  }
  existing?.stop();
  const registration = createRegistration(intervalMs);
  tickers.set(intervalMs, registration);
  return registration.ticker;
}

/** Drop every cached ticker and stop every running timer. Test-only. */
export function resetNowTickersForTests(): void {
  for (const registration of tickers.values()) {
    registration.stop();
  }
  tickers.clear();
}
