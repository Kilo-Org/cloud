import 'server-only';

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pool } from '@/lib/drizzle';
import { readPoolLeakStats } from '@/lib/db-pool-leak-probe';

/**
 * Diagnostics for the Frankfurt-local usage write.
 *
 * `POST /api/internal/usage/record` shows a strongly bimodal latency profile —
 * p50 around 5ms against a p95 near 50s — while the database is idle: zero
 * blocked sessions, sub-second oldest transaction, and only a handful of
 * `log_lock_waits` entries per hour. Supavisor is equally idle, reporting
 * `client_waiting: 0` against a pool size of 320. So the time is being spent
 * inside the Node process, and nothing currently emitted can say where.
 *
 * The two candidate explanations need different fixes, so they have to be
 * separated by measurement rather than argument:
 *
 * - Waiting on the in-process `pg` pool, which is capped at 10 connections per
 *   instance. `/api/cron/db-pool-metrics` reports Supavisor's counters, not this
 *   pool's, so its saturation is currently invisible. `waitingCount` settles it.
 * - Event-loop starvation, which would inflate every phase including ones that do
 *   no I/O at all. The delay histogram settles that one.
 *
 * Everything here is read-only and allocation-light. Emission is gated on a
 * duration threshold plus a small random sample, and it replaces a log line that
 * serialized ~30KB of interpolated SQL per failure, so net log volume falls.
 */

/**
 * Process-lifetime event-loop delay. Deliberately never reset: a sustained stall
 * is what we are looking for, and per-request windowing would need a timer of its
 * own on the very loop being measured.
 */
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const SLOW_EMIT_THRESHOLD_MS = 1_000;
const BASELINE_SAMPLE_RATE = 0.01;

export type UsageRecordPhase = { phase: string; ms: number };

export interface PhaseTimer {
  /** Closes the previous phase and records its duration. */
  mark(phase: string): void;
  phases(): UsageRecordPhase[];
  totalMs(): number;
}

export function createPhaseTimer(now: () => number = () => Date.now()): PhaseTimer {
  const start = now();
  let last = start;
  const recorded: UsageRecordPhase[] = [];
  return {
    mark(phase: string) {
      const at = now();
      recorded.push({ phase, ms: at - last });
      last = at;
    },
    phases: () => recorded,
    totalMs: () => now() - start,
  };
}

export type PoolGauges = {
  /** Connections the pool currently holds, idle or checked out. */
  total: number;
  idle: number;
  /** Requests queued for a connection. Non-zero means the pool is the bottleneck. */
  waiting: number;
};

export function readPoolGauges(): PoolGauges {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

function eventLoopLagMs() {
  return {
    mean_ms: Math.round(eventLoopDelay.mean / 1e6),
    p99_ms: Math.round(eventLoopDelay.percentile(99) / 1e6),
    max_ms: Math.round(eventLoopDelay.max / 1e6),
  };
}

export type UsageRecordTiming = {
  usageId: string;
  outcome: 'recorded' | 'duplicate' | 'not_recorded';
  totalMs: number;
  phases: UsageRecordPhase[];
  poolBefore: PoolGauges;
  poolAfter: PoolGauges;
  /** Highest `waitingCount` sampled during the request. */
  poolWaitingPeak: number;
  /**
   * Milliseconds since the previous request on this instance, `null` for the
   * first. Above `QUIET_INSTANCE_MS` the pool should have drained, so a non-zero
   * `checked_out` in the same line is a leaked slot.
   */
  msSinceLastRequest: number | null;
  /**
   * Checked-out connections observed at handler entry, before this request
   * acquired anything. On a quiet instance this should be zero.
   */
  checkedOutAtEntry: number;
};

/**
 * A request arriving after this much instance quiet is treated as an observation
 * point regardless of how fast it was. `idleTimeoutMillis` is 5s, so by then a
 * healthy pool has closed its idle clients and `checked_out` should be zero —
 * which is precisely when a leaked slot is visible. These requests are fast, so
 * the duration threshold would never surface them.
 */
const QUIET_INSTANCE_MS = 5_000;

export function shouldEmitUsageRecordTiming(
  totalMs: number,
  msSinceLastRequest: number | null = null,
  random: () => number = Math.random
): boolean {
  if (totalMs >= SLOW_EMIT_THRESHOLD_MS) return true;
  if (msSinceLastRequest !== null && msSinceLastRequest >= QUIET_INSTANCE_MS) return true;
  return random() < BASELINE_SAMPLE_RATE;
}

/**
 * Milliseconds since the previous request on this instance, or `null` for the
 * first one. Tracked here rather than in the route so the notion of "quiet" and
 * its emission threshold stay together.
 */
let lastRequestAtMs: number | null = null;

export function noteRequestStart(now: number = Date.now()): number | null {
  const since = lastRequestAtMs === null ? null : now - lastRequestAtMs;
  lastRequestAtMs = now;
  return since;
}

/** Test-only reset so quiet-period assertions do not depend on suite ordering. */
export function __resetRequestClockForTest(): void {
  lastRequestAtMs = null;
}

/**
 * One structured line, queryable in Axiom without regex over a message blob.
 */
export function emitUsageRecordTiming(timing: UsageRecordTiming): void {
  console.log(
    JSON.stringify({
      type: 'usage_record_timing',
      usage_id: timing.usageId,
      outcome: timing.outcome,
      total_ms: timing.totalMs,
      phases: Object.fromEntries(timing.phases.map(({ phase, ms }) => [`${phase}_ms`, ms])),
      pool_before: timing.poolBefore,
      pool_after: timing.poolAfter,
      pool_waiting_peak: timing.poolWaitingPeak,
      pool_max: poolMax(),
      event_loop_lag: eventLoopLagMs(),
      ms_since_last_request: timing.msSinceLastRequest,
      checked_out_at_entry: timing.checkedOutAtEntry,
      pool_leak: readPoolLeakStats(),
    })
  );
}

/**
 * `max` is not exposed on `pg.Pool` in the public types but is present on the
 * options object, and knowing it is what makes `waiting` interpretable.
 */
function poolMax(): number | null {
  const options = (pool as unknown as { options?: { max?: number } }).options;
  return typeof options?.max === 'number' ? options.max : null;
}

/**
 * Redacted description of a database error.
 *
 * A drizzle failure stringifies to `Failed query: <SQL>\nparams: <values>`. For
 * the usage write that is ~30KB and the values include `user_prompt_prefix`,
 * `system_prompt_prefix`, the client IP, city and JA4 digest — real end-user
 * prompt text in a log line that fired thousands of times per minute. Never log
 * or capture the raw error from this path; log this instead.
 *
 * `detail` is also omitted: PostgreSQL puts the conflicting key values in it.
 */
export type DatabaseErrorDescription = {
  name: string | null;
  code: string | null;
  constraint: string | null;
  table: string | null;
  routine: string | null;
};

type PostgresErrorShape = {
  name?: unknown;
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  routine?: unknown;
  cause?: unknown;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function describeDatabaseError(error: unknown): DatabaseErrorDescription {
  // drizzle wraps the driver error, so the fields we want sit on `cause`. Walk a
  // bounded chain rather than assuming a fixed depth.
  let current: unknown = error;
  let name: string | null = null;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as PostgresErrorShape;
    name ??= stringOrNull(candidate.name);
    const code = stringOrNull(candidate.code);
    if (code !== null) {
      return {
        // The outermost name identifies the failure class (`DrizzleQueryError`);
        // the driver's own name is just "error" and says nothing.
        name: name ?? stringOrNull(candidate.name),
        code,
        constraint: stringOrNull(candidate.constraint),
        table: stringOrNull(candidate.table),
        routine: stringOrNull(candidate.routine),
      };
    }
    current = candidate.cause;
  }
  return { name, code: null, constraint: null, table: null, routine: null };
}

/**
 * The frames of `error`'s stack under a caller-supplied header.
 *
 * V8 renders `error.stack` as `${name}: ${message}` followed by the frames, so
 * copying a stack verbatim onto a redacted error re-embeds the message it was
 * redacting — for this path, ~30KB of interpolated statement including prompt
 * prefixes and the client IP. Dropping the header keeps the throw site, which
 * `Error.captureStackTrace` on the replacement would lose.
 *
 * The header is removed by exact `${name}: ${message}` prefix, never by searching
 * for the first frame-shaped line. That search is unsafe here because the message
 * embeds `user_prompt_prefix`: a user pasting a stack trace into their prompt —
 * routine for a coding assistant — puts a line matching `/^\s+at\s/` inside the
 * message, and slicing from it carries the rest of the parameters, client IP
 * included, into the result.
 *
 * Fails closed. If the stack does not start with the expected header the message
 * boundary is unknown, so no frames are emitted at all; `describeDatabaseError`
 * still supplies the actionable code and constraint. Losing a throw site is
 * cheaper than leaking a prompt.
 */
export function stackFramesUnderHeader(error: unknown, header: string): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return header;
  const originalHeader = error.message.length > 0 ? `${error.name}: ${error.message}` : error.name;
  if (!error.stack.startsWith(originalHeader)) return header;
  // Belt and braces: after an exact strip nothing but frames can remain, but a
  // message mutated after construction would slip through, so keep only lines
  // that are actually frames.
  const frames = error.stack
    .slice(originalHeader.length)
    .split('\n')
    .filter(line => /^\s+at\s/.test(line));
  return frames.length > 0 ? `${header}\n${frames.join('\n')}` : header;
}

/** PostgreSQL `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Tables keyed by the per-delivery usage id. A collision on either means this
 * record is colliding with itself.
 */
const USAGE_IDENTITY_TABLES = new Set(['microdollar_usage', 'microdollar_usage_metadata']);

/**
 * `microdollar_usage`'s primary key predates the current naming convention, so it
 * carries a generated name while every deduplicated lookup table uses
 * `<table>_pkey`. Matched exactly, as a fallback for drivers that report
 * `constraint` without `table`.
 */
const USAGE_PRIMARY_KEY_CONSTRAINTS = new Set([
  'PK_a71b90d910e7882358c3defe8e2',
  'microdollar_usage_metadata_pkey',
]);

/**
 * True when the failure is this exact usage row colliding with itself.
 *
 * Retrying is futile: `id` is fixed for the delivery, so every attempt collides
 * again, and each one rebuilds and re-logs the same ~30KB statement. The caller
 * should stop and recover the committed row's identity instead.
 *
 * Deliberately narrower than "any unique violation". A collision on one of the
 * twelve deduplicated lookup tables IS worth retrying — two concurrent writes can
 * both pass the `WHERE NOT EXISTS` guard for a new value, and on the retry the
 * value exists and the insert is skipped. That is the race the retry loop was
 * built for, and it must keep working.
 */
export function isUsageRowConflict(error: unknown): boolean {
  const described = describeDatabaseError(error);
  if (described.code !== UNIQUE_VIOLATION) return false;
  if (described.table !== null) return USAGE_IDENTITY_TABLES.has(described.table);
  return described.constraint !== null && USAGE_PRIMARY_KEY_CONSTRAINTS.has(described.constraint);
}
