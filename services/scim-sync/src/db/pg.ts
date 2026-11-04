import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';

/**
 * Bounds both the statement and the connection.
 *
 * `statement_timeout` is sent in the PostgreSQL startup packet, so it cannot
 * fire until a connection exists. A database or Hyperdrive that refuses or
 * blackholes new connections would otherwise wait on `pg.Pool`'s default, which
 * has no client-side connect timeout — the exact outage `/status` exists to
 * report. Same reasoning as `services/ai-attribution/src/util/auth.ts`.
 */
const TIMEOUT_MS = 10_000;

/**
 * Return a Drizzle client for the shared PostgreSQL reachable through the
 * `HYPERDRIVE` binding.
 *
 * `getWorkerDb` opens a fresh `max: 1` pool per call — Hyperdrive owns the real
 * pooling — so callers must invoke this per operation and never cache the
 * result in module scope. A cached client outlives the request or Durable
 * Object context that created it, and its I/O then fails in whatever context
 * picks it up next.
 */
export function getPgDb(env: Pick<Env, 'HYPERDRIVE'>): WorkerDb {
  return getWorkerDb(env.HYPERDRIVE.connectionString, {
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
  });
}

export type { WorkerDb };
