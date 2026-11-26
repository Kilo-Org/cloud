import {
  AudienceSchema,
  MAX_AUDIENCES_PER_MINT,
  MintResultSchema,
  SERVICE_TOKEN_RENEW_FRACTION,
  ScopeSchema,
  scopeAudience,
  type IssuedToken,
  type MintRequest,
  type MintResult,
} from '@kilocode/sts-contracts';
import { ServiceTokenError, type ServiceTokenDeniedReason } from './errors';
import type { ServiceTokenRequest, ServiceTokens, ServiceTokensExecutionContext } from './types';

/** Sends one mint request and returns the result; a transport error rejects. */
export type MintTransport = (request: MintRequest) => Promise<MintResult>;

/**
 * How long a read that needs a mint waits for other reads to join its call: reads of one request
 * (`Promise.all` over its audiences) and of concurrent requests in the isolate share one STS call
 * of up to 8 tokens. Paid once per cold start and never on a renewal, which runs in the background.
 */
export const MINT_BATCH_WINDOW_MS = 10;
/**
 * A held token is served while renewal fails until this many seconds before its `exp`, never
 * later: the request that presents it needs time to reach the callee. A 300 s token renews at
 * 240 s and keeps serving until 270 s.
 */
export const HELD_TOKEN_MARGIN_SECONDS = 30;
/**
 * A denied token stays denied, with no STS call, for this long; the next read after it asks STS
 * again, so a policy fix reaches a running instance. Only a successful mint for that audience and
 * scope clears the denial.
 */
export const DENIED_RECHECK_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
/**
 * How often a read that waits for another request's attempt checks the shared cache. It cannot
 * await that request's promise (see `Attempt`), so it looks again on its own timer: first after
 * 25 ms, then doubling up to 250 ms, so a 30 s wait wakes about 125 times, not 1,200.
 */
export const POLL_START_MS = 25;
export const POLL_MAX_MS = 250;

/**
 * Delay before the attempt that follows the nth consecutive failure: 2 s doubling to 60 s, minus
 * up to 25 % jitter so instances that failed together spread their retries.
 */
function backoffMs(failures: number): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  return step - Math.random() * step * 0.25;
}

export type ServiceTokensOptions = {
  /**
   * An attempt that has not settled this long after it started counts as failed, and the next one
   * waits out the backoff; a success it returns later still lands unless a newer one already did.
   * A cold read waits at most this long.
   */
  attemptTimeoutMs: number;
};

/**
 * Plain data, shared by every request in the isolate: one STS call (or one batch split into calls
 * of at most 8 tokens) for every key in `keys`. The promise of the call lives only in the request
 * that started it (`Owned`): workerd ties a promise to the request that created it, and once that
 * request ends its pending calls are cancelled and the continuations of its promises are dropped,
 * even ones another request registered.
 */
type Attempt = {
  id: number;
  startedAt: number;
  /** Entries this attempt mints; reads join it until it is sent. */
  entries: Entry[];
};

/**
 * An attempt this read started. Only this read awaits `settled` or hands it to `waitUntil`. `wake`
 * is set while the read sleeps in `waitFor`, so an answer wakes it at once.
 */
type Owned = {
  attempt: Attempt;
  settled: Promise<void>;
  pending: boolean;
  wake: (() => void) | null;
};

type Held = { token: string; renewAt: number; usableUntil: number };

/** The failures since the last answer; `count` sets the backoff. */
type Failure = { count: number; retryAt: number; cause: unknown };

type Fetch =
  | { state: 'idle' }
  | { state: 'running'; attempt: Attempt; failure: Failure | null }
  | { state: 'backing_off'; failure: Failure };

/**
 * One audience and scope. The four states: empty (`held` and `denied` null, idle), cold (no token,
 * an attempt running or backing off), ready (`held` set) and denied (`denied` set). A denial drops
 * the held token: STS no longer grants it.
 */
type Entry = {
  target: ServiceTokenRequest;
  held: Held | null;
  denied: { reason: ServiceTokenDeniedReason; recheckAt: number } | null;
  fetch: Fetch;
  /** Id of the attempt whose answer (token or denial) the entry holds; an older one never replaces it. */
  appliedId: number;
};

type CallOutcome =
  | { kind: 'issued'; token: IssuedToken }
  | { kind: 'denied'; reason: ServiceTokenDeniedReason }
  | { kind: 'failed'; retryAfterMs: number; cause: unknown };

/**
 * Groups keys into calls STS accepts: at most 8 tokens each, one token per audience. Two scopes
 * of one audience go to two calls of the same batch.
 */
function splitIntoCalls(entries: readonly Entry[]): Entry[][] {
  const calls: Entry[][] = [];
  for (const entry of entries) {
    const call = calls.find(
      candidate =>
        candidate.length < MAX_AUDIENCES_PER_MINT &&
        !candidate.some(other => other.target.audience === entry.target.audience)
    );
    if (call === undefined) calls.push([entry]);
    else call.push(entry);
  }
  return calls;
}

export function createServiceTokens(
  transport: MintTransport,
  options: ServiceTokensOptions
): ServiceTokens {
  const { attemptTimeoutMs } = options;
  /** Long enough for a slow answer to still land, short enough to bound a hung call. */
  const keepAliveMs = MINT_BATCH_WINDOW_MS + attemptTimeoutMs + 5_000;
  const entries = new Map<string, Entry>();
  let nextAttemptId = 1;
  /** The attempt reads may still join; null once it is sent. */
  let open: Attempt | null = null;

  function entryFor(target: ServiceTokenRequest): Entry {
    const key = `${target.audience} ${target.scope}`;
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { target, held: null, denied: null, fetch: { state: 'idle' }, appliedId: 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  function unavailable(entry: Entry, retryAt: number, cause?: unknown): ServiceTokenError {
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    return new ServiceTokenError({ reason: 'unavailable', retryAfterSeconds }, entry.target, {
      cause,
    });
  }

  function fail(entry: Entry, attempt: Attempt, at: number, retryAfterMs: number, cause: unknown) {
    const fetch = entry.fetch;
    if (fetch.state !== 'running' || fetch.attempt !== attempt) return;
    const count = (fetch.failure?.count ?? 0) + 1;
    const retryAt = at + Math.max(backoffMs(count), retryAfterMs);
    entry.fetch = { state: 'backing_off', failure: { count, retryAt, cause } };
  }

  function apply(entry: Entry, attempt: Attempt, outcome: CallOutcome, at: number): void {
    if (outcome.kind === 'failed') {
      fail(entry, attempt, at, outcome.retryAfterMs, outcome.cause);
      return;
    }
    if (attempt.id <= entry.appliedId) return;
    entry.appliedId = attempt.id;
    entry.fetch = { state: 'idle' };
    if (outcome.kind === 'denied') {
      entry.held = null;
      entry.denied = { reason: outcome.reason, recheckAt: at + DENIED_RECHECK_MS };
      return;
    }
    entry.denied = null;
    const expiresAtMs = outcome.token.expiresAt * 1000;
    const usableUntil = expiresAtMs - HELD_TOKEN_MARGIN_SECONDS * 1000;
    // Measured from receipt against `exp`, so it needs no `iat` and survives a skewed clock.
    const renewAt = Math.min(at + (expiresAtMs - at) * SERVICE_TOKEN_RENEW_FRACTION, usableUntil);
    entry.held = { token: outcome.token.token, renewAt, usableUntil };
  }

  /** One STS call; never rejects. */
  async function call(attempt: Attempt, batch: Entry[]): Promise<void> {
    const request: MintRequest = {
      tokens: batch.map(entry => ({ audience: entry.target.audience, scope: entry.target.scope })),
    };
    const outcomes = await mint(transport, request);
    const at = Date.now();
    batch.forEach((entry, index) => apply(entry, attempt, outcomes[index], at));
  }

  /** Waits out the batch window, then sends every key that joined, split into calls. */
  async function send(attempt: Attempt): Promise<void> {
    const window = Promise.withResolvers<void>();
    setTimeout(window.resolve, MINT_BATCH_WINDOW_MS);
    await window.promise;
    // Reads that arrive from now on open the next attempt.
    if (open === attempt) open = null;
    const batch = attempt.entries.filter(
      entry => entry.fetch.state === 'running' && entry.fetch.attempt === attempt
    );
    await Promise.all(splitIntoCalls(batch).map(calls => call(attempt, calls)));
  }

  /** Puts `entry` in the open attempt, or opens one that the calling read owns. */
  function start(entry: Entry, at: number, owned: Owned[]): Attempt {
    const failure = entry.fetch.state === 'backing_off' ? entry.fetch.failure : null;
    let attempt = open;
    if (attempt === null) {
      attempt = { id: nextAttemptId++, startedAt: at, entries: [] };
      open = attempt;
      const own: Owned = {
        attempt,
        settled: send(attempt).finally(() => {
          own.pending = false;
          own.wake?.();
        }),
        pending: true,
        wake: null,
      };
      owned.push(own);
    }
    attempt.entries.push(entry);
    entry.fetch = { state: 'running', attempt, failure };
    return attempt;
  }

  function timeOut(entry: Entry, attempt: Attempt): void {
    fail(
      entry,
      attempt,
      attempt.startedAt + attemptTimeoutMs,
      0,
      new Error(`STS did not answer within ${attemptTimeoutMs} ms`)
    );
  }

  /**
   * Sleeps `pollMs`, or less when `deadline` comes first; an answer to one of this read's own
   * attempts wakes it sooner. Its timer is cleared or has fired before it returns.
   */
  async function waitFor(owned: Owned[], deadline: number, pollMs: number): Promise<void> {
    const timer = Promise.withResolvers<void>();
    const handle = setTimeout(timer.resolve, Math.max(0, Math.min(pollMs, deadline - Date.now())));
    for (const own of owned) own.wake = timer.resolve;
    await timer.promise;
    clearTimeout(handle);
    for (const own of owned) own.wake = null;
  }

  function withinKeepAlive(settled: Promise<void>): Promise<void> {
    const bound = Promise.withResolvers<void>();
    const handle = setTimeout(bound.resolve, keepAliveMs);
    return Promise.race([settled, bound.promise]).finally(() => clearTimeout(handle));
  }

  async function read(entry: Entry, owned: Owned[]): Promise<string> {
    const arrivedAt = Date.now();
    /** The attempt this read started or joined; it waits for that one only. */
    let mine: Attempt | null = null;
    let pollMs = POLL_START_MS;
    for (;;) {
      const at = Date.now();
      const { fetch, held } = entry;
      if (fetch.state === 'running' && at >= fetch.attempt.startedAt + attemptTimeoutMs) {
        timeOut(entry, fetch.attempt);
        continue;
      }
      if (entry.denied !== null) {
        // Sticky until a mint succeeds: only the read that asks STS again waits for the answer.
        const waiting = fetch.state === 'running' && fetch.attempt === mine;
        const retryDue =
          fetch.state === 'idle' || (fetch.state === 'backing_off' && at >= fetch.failure.retryAt);
        if (!waiting && (at < entry.denied.recheckAt || !retryDue)) {
          throw new ServiceTokenError(
            { reason: 'denied', deniedReason: entry.denied.reason },
            entry.target
          );
        }
        if (!waiting) {
          mine = start(entry, at, owned);
          continue;
        }
      } else {
        if (held !== null && at < held.renewAt) return held.token;
        const usable = held !== null && at < held.usableUntil;
        if (
          fetch.state === 'idle' ||
          (fetch.state === 'backing_off' && at >= fetch.failure.retryAt)
        ) {
          mine = start(entry, at, owned);
          continue;
        }
        if (usable) return held.token;
        if (fetch.state === 'backing_off') {
          throw unavailable(entry, fetch.failure.retryAt, fetch.failure.cause);
        }
      }
      // A running attempt and no token to serve: wait for its answer or its timeout.
      if (fetch.state !== 'running') continue;
      const timesOutAt = fetch.attempt.startedAt + attemptTimeoutMs;
      const giveUpAt = arrivedAt + attemptTimeoutMs;
      if (at >= giveUpAt) {
        throw unavailable(
          entry,
          at + BACKOFF_BASE_MS,
          new Error('no STS answer before this read gave up')
        );
      }
      await waitFor(owned, Math.min(timesOutAt, giveUpAt), pollMs);
      pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
    }
  }

  return {
    async get(target, ctx?: ServiceTokensExecutionContext) {
      if (
        !AudienceSchema.safeParse(target.audience).success ||
        !ScopeSchema.safeParse(target.scope).success ||
        scopeAudience(target.scope) !== target.audience
      ) {
        throw new ServiceTokenError({ reason: 'denied', deniedReason: 'invalid_request' }, target);
      }
      const owned: Owned[] = [];
      try {
        return await read(entryFor(target), owned);
      } finally {
        // Every exit hands this read's unsent or unanswered attempts to its own `waitUntil`, each
        // for a bounded time: a call whose request ends is cancelled. Another request's attempt is
        // never handed over.
        if (ctx !== undefined) {
          for (const own of owned) if (own.pending) ctx.waitUntil(withinKeepAlive(own.settled));
        }
      }
    },
  };
}

/** Sends one call and maps its answer to one outcome per requested token, in request order. */
async function mint(transport: MintTransport, request: MintRequest): Promise<CallOutcome[]> {
  const all = (outcome: CallOutcome) => request.tokens.map(() => outcome);
  let result: MintResult;
  try {
    result = MintResultSchema.parse(await transport(request));
  } catch (cause) {
    return all({ kind: 'failed', retryAfterMs: 0, cause });
  }
  switch (result.status) {
    case 'unavailable':
      return all({
        kind: 'failed',
        retryAfterMs: result.retryAfterSeconds * 1000,
        cause: new Error('STS answered unavailable'),
      });
    case 'identity_rejected':
    case 'invalid_request':
      return all({ kind: 'denied', reason: result.status });
    case 'ok':
      return request.tokens.map((wanted, index): CallOutcome => {
        const answer = result.tokens[index];
        if (answer?.audience !== wanted.audience || answer.scope !== wanted.scope) {
          return {
            kind: 'failed',
            retryAfterMs: 0,
            cause: new Error('STS answered a token the client did not request at this position'),
          };
        }
        return answer.status === 'issued'
          ? { kind: 'issued', token: answer }
          : { kind: 'denied', reason: answer.reason };
      });
  }
}
