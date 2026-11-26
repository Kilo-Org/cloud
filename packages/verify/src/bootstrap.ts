import {
  abandoned,
  liveness,
  retryAfterSeconds,
  sleep,
  startOwned,
  type CallScope,
  type Liveness,
} from './flight';
import {
  JWKS_MAX_STALE_MS,
  importKeySet,
  parseKeySetAges,
  type KeySetAges,
  type KeySetCache,
} from './jwks';
import { parseRevocationList, verifyFeedHead, type RevocationFeed } from './revocation';

/** A bootstrap call that has not answered by then counts as a failure. */
export const BOOTSTRAP_FETCH_TIMEOUT_MS = 5_000;
/** After a failed bootstrap call, the next one waits this long; cold requests meanwhile get 503. */
export const BOOTSTRAP_RETRY_MS = 5_000;

/**
 * One UTS bootstrap answer (design 7, cold start): the UTS key set with its ages, a signed feed
 * head and its list.
 */
export type UtsBootstrapAnswer = {
  /** The UTS key-set body, as `JwksSource` returns it. */
  jwks: unknown;
  /**
   * The key set's ages when the feed Worker answered, as `JwksSource` returns them. Required: an
   * answer without valid ages is a failed call, so a bootstrap never restarts a key's age.
   */
  keyAges: KeySetAges;
  /** The current head: a compact JWS, as `RevocationFeedSource.head` returns it. */
  head: string;
  /** The list bytes that head covers, as `RevocationFeedSource.list` returns them. */
  list: Uint8Array<ArrayBuffer>;
};

/** The UTS bootstrap endpoint (phase 3 implements the call). Any rejection is a failed call. */
export type UtsBootstrapSource = (signal: AbortSignal) => Promise<UtsBootstrapAnswer>;

export type BootstrapRead =
  | { status: 'ready' }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type Bootstrap = {
  /**
   * While neither the UTS key set nor the feed holds data, loads both from one bootstrap call and
   * waits for it; once either holds data, answers `ready` at once and the separate sources refresh.
   */
  load(scope: CallScope): Promise<BootstrapRead>;
  /** Starts the bootstrap call when it is needed, idle and outside its retry wait. */
  prefetch(scope: CallScope): void;
};

type Attempt = Liveness & { id: number };
type Failure = { attemptId: number; retryAt: number };

/**
 * The cold-start loader for one isolate. A bootstrap answer applies whole or not at all: the key
 * set must parse and carry valid ages, the head must verify under a feed key of that set and count
 * (design 5.6), and the list must match the head's hash.
 */
export function createBootstrap(
  source: UtsBootstrapSource,
  keySet: KeySetCache,
  feed: RevocationFeed
): Bootstrap {
  let attempt: Attempt | null = null;
  let failure: Failure | null = null;
  let nextAttemptId = 1;

  const needed = () => keySet.cold() && feed.cold();

  function fail(done: Attempt, at: number): void {
    if (attempt?.id !== done.id) return;
    attempt = null;
    failure = { attemptId: done.id, retryAt: at + BOOTSTRAP_RETRY_MS };
  }

  function start(scope: CallScope, at: number): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextAttemptId++ };
    attempt = started;
    startOwned(scope, started, BOOTSTRAP_FETCH_TIMEOUT_MS, async answered => {
      try {
        const answer = await source(AbortSignal.timeout(BOOTSTRAP_FETCH_TIMEOUT_MS));
        const keyAges = parseKeySetAges(answer.keyAges);
        if (keyAges === null) throw new Error('bootstrap answer without valid key ages');
        // The key set would not be held, so the answer would not apply whole.
        if (keyAges.oldest * 1000 >= JWKS_MAX_STALE_MS) {
          throw new Error('bootstrap key set past its 24-hour limit');
        }
        const keys = await importKeySet(answer.jwks, 'uts');
        const head = await verifyFeedHead(answer.head, kid => keys.feedKeys.get(kid) ?? null);
        const list = await parseRevocationList(head.listHash, answer.list);
        if (!feed.install({ head, list }, Date.now())) {
          throw new Error('bootstrap head does not count');
        }
        keySet.install(keys, keyAges, started.startedAt);
        if (attempt?.id === started.id) attempt = null;
        failure = null;
      } catch {
        fail(started, Date.now());
      }
      answered();
    });
    return started;
  }

  return {
    async load(scope) {
      let awaited: number | null = null;
      for (;;) {
        if (!needed()) return { status: 'ready' };
        const now = Date.now();
        if (
          attempt !== null &&
          (now >= attempt.startedAt + BOOTSTRAP_FETCH_TIMEOUT_MS || abandoned(attempt, scope, now))
        ) {
          // Past its timeout, or its request was cancelled: a failed call, with the retry wait.
          fail(attempt, Math.min(now, attempt.startedAt + BOOTSTRAP_FETCH_TIMEOUT_MS));
          continue;
        }
        if (attempt !== null) {
          awaited ??= attempt.id;
          await sleep(scope, attempt.startedAt + BOOTSTRAP_FETCH_TIMEOUT_MS);
          continue;
        }
        if (failure !== null && (failure.attemptId === awaited || now < failure.retryAt)) {
          return {
            status: 'unavailable',
            retryAfterSeconds: retryAfterSeconds(failure.retryAt, now),
          };
        }
        awaited = start(scope, now).id;
      }
    },
    prefetch(scope) {
      const now = Date.now();
      const backingOff = failure !== null && now < failure.retryAt;
      if (needed() && attempt === null && !backingOff) start(scope, now);
    },
  };
}
