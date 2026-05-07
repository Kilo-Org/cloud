import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';

/**
 * Return a Drizzle client bound to the Postgres instance reachable via the
 * worker's `HYPERDRIVE` binding.
 *
 * `getWorkerDb` creates a new pool per call with `max: 1` — callers should
 * cache the returned client per-request (inside a handler), not at module
 * scope, to match the Workers isolate lifecycle.
 */
export function getPgDb(env: Pick<Env, 'HYPERDRIVE'>): WorkerDb {
  return getWorkerDb(env.HYPERDRIVE.connectionString);
}
