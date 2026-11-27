import pg from 'pg';
import { z } from 'zod';
import { LEASE_REPLICA_SWEEP_STEP_TIMEOUT_MS } from '../constants';

/**
 * Runs `kilo_lease.sweep_sessions()` once on one replica and returns the number of sessions it
 * ended. Throws when the replica cannot be reached or the call fails.
 */
export type ReplicaSweep = (connectionString: string) => Promise<number>;

const SweepRowSchema = z.object({ ended: z.number().int().nonnegative() });

/**
 * One connection through the replica's Hyperdrive binding, one statement, then the close. The
 * connection and the statement each give up after `LEASE_REPLICA_SWEEP_STEP_TIMEOUT_MS`, and the
 * sweeper login's `statement_timeout` (5 s) bounds the statement at the server too. The Hyperdrive
 * configuration must have caching disabled: the statement reads like a query, and a cached answer
 * would end no session.
 * https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
 */
export const sweepReplica: ReplicaSweep = async connectionString => {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: LEASE_REPLICA_SWEEP_STEP_TIMEOUT_MS,
    query_timeout: LEASE_REPLICA_SWEEP_STEP_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query('SELECT kilo_lease.sweep_sessions() AS ended');
    return SweepRowSchema.parse(result.rows[0]).ended;
  } finally {
    await client.end().catch(() => undefined);
  }
};
