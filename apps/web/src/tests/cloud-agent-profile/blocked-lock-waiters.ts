import type { PoolClient } from 'pg';

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Poll `pg_locks` until `expected` other backends of this test connection are
 * blocked on a lock. Observing the lock waits proves the operations actually
 * overlapped instead of assuming it from a fixed sleep.
 */
export async function waitForBlockedLockWaiters(
  client: PoolClient,
  expected: number
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(DISTINCT locked.pid)::int AS n
         FROM pg_locks locked
         JOIN pg_stat_activity activity ON activity.pid = locked.pid
        WHERE NOT locked.granted
          AND activity.datname = current_database()
          AND activity.application_name = current_setting('application_name')
          AND locked.pid <> pg_backend_pid()`
    );
    if (rows[0].n >= expected) return;
    if (Date.now() > deadline) {
      const diagnostics = await client.query<{ wait: string | null; query: string }>(
        `SELECT wait_event_type || ':' || coalesce(wait_event, '') AS wait, query
           FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`
      );
      throw new Error(
        `timed out waiting for ${expected} lock waiters; activity: ${JSON.stringify(diagnostics.rows)}`
      );
    }
    await sleep(20);
  }
}

/** Release a held test transaction even when an assertion failed mid-test. */
export async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Already committed or rolled back; nothing left to release.
  }
}
