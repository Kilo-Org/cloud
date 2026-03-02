import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

// Per-request DB connection via Hyperdrive
export function getWorkerDb(connectionString: string) {
  const client = new pg.Client({ connectionString });
  // Hyperdrive manages the actual pool; we create a lightweight wrapper per-request.
  // The connection is established lazily on first query.
  return {
    db: drizzle({ client }),
    connect: () => client.connect(),
    end: () => client.end(),
  };
}

export type WorkerDb = ReturnType<typeof getWorkerDb>['db'];
