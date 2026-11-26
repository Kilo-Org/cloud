/**
 * Owner-and-poller merging of dependency calls (JWKS, revocation feed, PAT lookups).
 *
 * workerd ties a promise to the request that created it: once that request ends, its pending
 * calls are cancelled and the continuations of its promises are dropped, even ones another
 * request registered. So isolate-level state holds plain data only. The request that starts a
 * call owns its promise and is the only one that awaits it; the call writes its answer into the
 * shared plain state, and every other request that wants that answer polls the state on its own
 * timer. On exit, a request hands its unanswered calls to its own `waitUntil`, bounded by
 * `KEEP_ALIVE_MS`, so an answer can still land in the shared state.
 *
 * A request can also be cancelled outright (its client went away), and then its call never
 * answers. While a call is pending its owner marks it alive on its own timer, which workerd
 * stops with the request; a poller that sees no mark for `ABANDONED_AFTER_MS` drops the call
 * instead of waiting out its timeout. The key-set cache, the feed and the bootstrap count a
 * dropped call as a failed one, with its retry wait, so cancelling requests cannot make them fetch
 * more often; the PAT resolver lets the poller start its own lookup, within the per-address limit.
 */

export type WaitUntil = (promise: Promise<unknown>) => void;

/** How often a request waiting on another request's call looks at the shared state again. */
export const POLL_MS = 25;

/** Longest a request's `waitUntil` keeps an unanswered call alive after the request returns. */
export const KEEP_ALIVE_MS = 30_000;

/** How often the owner of a pending call marks it alive. */
export const HEARTBEAT_MS = 100;

/** A pending call its owner has not marked alive for this long belongs to a cancelled request. */
export const ABANDONED_AFTER_MS = 1_000;

type Owned = {
  settled: Promise<void>;
  pending: boolean;
  wake: (() => void) | null;
};

/** The calls one `verify` started. Never shared between requests; `id` names it in shared state. */
export type CallScope = { readonly id: number; readonly owned: Owned[] };

let nextScopeId = 1;

export function newCallScope(): CallScope {
  return { id: nextScopeId++, owned: [] };
}

/** The plain, shared part of a pending call: its owner and when the owner last marked it alive. */
export type Liveness = { owner: number; startedAt: number; aliveAt: number };

export function liveness(scope: CallScope, at: number): Liveness {
  return { owner: scope.id, startedAt: at, aliveAt: at };
}

/** Whether `call` belongs to another request that stopped marking it alive: it will never answer. */
export function abandoned(call: Liveness, scope: CallScope, now: number): boolean {
  return call.owner !== scope.id && now - call.aliveAt >= ABANDONED_AFTER_MS;
}

/**
 * Starts a call this request owns. `work` must write its outcome into shared plain state and call
 * `answered` once it has, which wakes this request if it sleeps in `sleep`; anything `work` does
 * after that (a shared-cache write) still runs under the request's `waitUntil`. Until `work`
 * settles or `timeoutMs` passes, this request's timer marks `call` alive. A rejection of `work` is
 * a bug in the caller and is swallowed only so it cannot become an unhandled rejection.
 */
export function startOwned(
  scope: CallScope,
  call: Liveness,
  timeoutMs: number,
  work: (answered: () => void) => Promise<void>
): void {
  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (now >= call.startedAt + timeoutMs) clearInterval(heartbeat);
    else call.aliveAt = now;
  }, HEARTBEAT_MS);
  const own: Owned = { settled: Promise.resolve(), pending: true, wake: null };
  own.settled = work(() => own.wake?.())
    .catch(() => {})
    .finally(() => {
      clearInterval(heartbeat);
      own.pending = false;
      own.wake?.();
    });
  scope.owned.push(own);
}

/**
 * Sleeps one poll interval, or until `deadline` when that comes first; an answer to one of this
 * request's own calls wakes it at once. Its timer is cleared or has fired before it returns.
 */
export async function sleep(scope: CallScope, deadline: number): Promise<void> {
  const timer = Promise.withResolvers<void>();
  const handle = setTimeout(timer.resolve, Math.max(0, Math.min(POLL_MS, deadline - Date.now())));
  for (const own of scope.owned) own.wake = timer.resolve;
  await timer.promise;
  clearTimeout(handle);
  for (const own of scope.owned) own.wake = null;
}

/** Hands this request's unanswered calls to its own `waitUntil`, each for at most `KEEP_ALIVE_MS`. */
export function handOff(scope: CallScope, waitUntil: WaitUntil): void {
  for (const own of scope.owned) {
    if (!own.pending) continue;
    const bound = Promise.withResolvers<void>();
    const handle = setTimeout(bound.resolve, KEEP_ALIVE_MS);
    waitUntil(Promise.race([own.settled, bound.promise]).finally(() => clearTimeout(handle)));
  }
}

/** Seconds until `at`, at least 1: the `Retry-After` of a dependency failure. */
export function retryAfterSeconds(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/**
 * The wait before the next call after `consecutive` failed ones: `baseMs`, doubled per further
 * failure, at most `capMs`.
 */
export function backoffMs(baseMs: number, capMs: number, consecutive: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, consecutive - 1));
}
