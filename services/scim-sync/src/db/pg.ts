import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';

/** Bounds a query so a slow or wedged primary surfaces as an error, not a hang. */
const STATEMENT_TIMEOUT_MS = 10_000;

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
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
}

export type { WorkerDb };
