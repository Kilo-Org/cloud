import 'server-only';

import { pool } from '@/lib/drizzle';

/**
 * Read-only probe that decides whether pooled connections are being leaked.
 *
 * `/api/internal/usage/record` shows the in-process pool pinned at `idle: 0` with
 * up to 245 requests queued against `max: 10`, while PostgreSQL reports zero
 * active queries and Supavisor reports zero waiting clients. Connections are
 * therefore checked out without doing work, and there are two very different
 * explanations:
 *
 * 1. Vercel Fluid compute packs high concurrency onto few instances, so ten
 *    connections are genuinely in use and the cap is simply too low. Fix: more
 *    connections.
 * 2. Slots are leaked and never come back. drizzle-orm 0.45.2 issues `BEGIN`
 *    *outside* its `try`/`finally`, so a `BEGIN` that fails never reaches the
 *    `release()` in the `finally` and burns that slot for the life of the
 *    process. Ten of those kill an instance permanently. Fix: release on a failed
 *    `BEGIN`. Raising `max` would only postpone and hide it.
 *
 * Guessing wrong is expensive in opposite directions, so measure instead. Note
 * `max` in `drizzle.ts` is a single module-level constant shared by every route in
 * both Vercel projects, and its comment records that raising it previously
 * exhausted Supabase's connection limit across ~2,200 instances.
 *
 * The discriminator is the **low-water mark** of checked-out connections. A
 * healthy pool returns to zero checked out whenever the instance goes quiet, and
 * `idleTimeoutMillis` of 5s then closes the idle clients. A leaked client is never
 * returned to `_idle`, so it is counted as checked out forever and the low-water
 * mark can never fall back below the number of leaks.
 *
 * A low-water mark is deliberately chosen over an instantaneous reading because
 * this pool is shared with every other route on the instance: a single quiet
 * moment resets it, so concurrent unrelated traffic cannot inflate it. If it
 * climbs over an instance's lifetime and tracks `beginFailures`, explanation 2 is
 * confirmed with a number.
 *
 * Everything here is counters updated on pool events. No queries, no timers.
 */

type PoolLeakCounters = {
  acquires: number;
  releases: number;
  connects: number;
  removes: number;
  /**
   * Failures of the `BEGIN` statement itself. Under the drizzle bug each one is
   * exactly one permanently leaked slot, which is what makes this directly
   * comparable to `minCheckedOut`.
   */
  beginFailures: number;
  maxCheckedOut: number;
  /** Low-water mark of checked-out connections. The leak discriminator. */
  minCheckedOut: number;
  startedAtMs: number;
};

const counters: PoolLeakCounters = {
  acquires: 0,
  releases: 0,
  connects: 0,
  removes: 0,
  beginFailures: 0,
  maxCheckedOut: 0,
  minCheckedOut: Number.POSITIVE_INFINITY,
  startedAtMs: Date.now(),
};

function checkedOut(): number {
  return pool.totalCount - pool.idleCount;
}

function sampleCheckedOut(): void {
  const current = checkedOut();
  if (current > counters.maxCheckedOut) counters.maxCheckedOut = current;
  if (current < counters.minCheckedOut) counters.minCheckedOut = current;
}

// Attaching in the test environment would leave the counters at the mercy of
// whatever the shared Jest pool does, and `drizzle.ts` already treats the test
// pool as a special case for the same reason.
if (process.env.NODE_ENV !== 'test') {
  pool.on('acquire', () => {
    counters.acquires++;
    sampleCheckedOut();
  });
  pool.on('release', () => {
    counters.releases++;
    sampleCheckedOut();
  });
  pool.on('connect', () => {
    counters.connects++;
  });
  pool.on('remove', () => {
    counters.removes++;
    sampleCheckedOut();
  });
}

export function recordTransactionBeginFailure(): void {
  counters.beginFailures++;
}

/**
 * True when the failing statement was the transaction's own `BEGIN`.
 *
 * Safe to match on the message, unlike every other statement in this path:
 * `BEGIN` takes no parameters, so the drizzle message carries no prompt text,
 * client IP or other request data.
 */
export function isTransactionBeginFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (
      typeof candidate.message === 'string' &&
      /^failed query:\s*begin\b/i.test(candidate.message.trim())
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export type PoolLeakReading = {
  acquires: number;
  releases: number;
  connects: number;
  removes: number;
  begin_failures: number;
  checked_out: number;
  max_checked_out: number;
  /**
   * `null` until the first pool event. Above zero after a quiet period is the
   * leak signature; compare against `begin_failures`.
   */
  min_checked_out: number | null;
  /**
   * `acquires - releases`. Should equal `checked_out`; a persistent divergence
   * means the accounting itself is wrong and the rest should not be trusted.
   */
  outstanding: number;
  instance_uptime_ms: number;
};

export function readPoolLeakStats(): PoolLeakReading {
  return {
    acquires: counters.acquires,
    releases: counters.releases,
    connects: counters.connects,
    removes: counters.removes,
    begin_failures: counters.beginFailures,
    checked_out: checkedOut(),
    max_checked_out: counters.maxCheckedOut,
    min_checked_out: Number.isFinite(counters.minCheckedOut) ? counters.minCheckedOut : null,
    outstanding: counters.acquires - counters.releases,
    instance_uptime_ms: Date.now() - counters.startedAtMs,
  };
}

/** Test-only reset so counter assertions do not depend on suite ordering. */
export function __resetPoolLeakCountersForTest(): void {
  counters.acquires = 0;
  counters.releases = 0;
  counters.connects = 0;
  counters.removes = 0;
  counters.beginFailures = 0;
  counters.maxCheckedOut = 0;
  counters.minCheckedOut = Number.POSITIVE_INFINITY;
  counters.startedAtMs = Date.now();
}
