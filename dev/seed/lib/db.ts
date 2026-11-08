import '../../../apps/web/src/lib/load-env';

import { computeDatabaseUrl, createDrizzleClient, type DrizzleClient } from '@kilocode/db';

process.env.IS_SCRIPT = 'true';

const LOOPBACK_DATABASE_HOSTS: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
};

/**
 * Refuses a topic that writes unless the database `getSeedDb()` connects to is
 * loopback. `computeDatabaseUrl()` prefers `POSTGRES_URL_PRODUCTION` when
 * `USE_PRODUCTION_DB=true`, so this checks the connection URL the topic really
 * writes to.
 *
 * Call it before the first statement that reads or writes. Returns the
 * validated hostname.
 */
export function assertLocalSeedDatabase(fixture: string): string {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error(`${fixture} refuses to run with USE_PRODUCTION_DB=true.`);
  }
  const hostname = new URL(computeDatabaseUrl()).hostname;
  if (!Object.hasOwn(LOOPBACK_DATABASE_HOSTS, hostname)) {
    throw new Error(`${fixture} requires a loopback database host; received ${hostname}.`);
  }
  return hostname;
}

let drizzleClient: DrizzleClient | null = null;

export function getSeedDb() {
  if (drizzleClient) {
    return drizzleClient.db;
  }

  drizzleClient = createDrizzleClient({
    connectionString: computeDatabaseUrl(),
    poolConfig: {
      application_name: 'kilocode-dev-seed',
      max: 1,
    },
  });

  return drizzleClient.db;
}

export async function closeSeedDb(): Promise<void> {
  if (!drizzleClient) {
    return;
  }

  await drizzleClient.pool.end();
  drizzleClient = null;
}
