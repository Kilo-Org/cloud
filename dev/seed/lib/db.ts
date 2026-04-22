import '../../../apps/web/src/lib/load-env';

import { computeDatabaseUrl, createDrizzleClient, type DrizzleClient } from '@kilocode/db';

process.env.IS_SCRIPT = 'true';

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
